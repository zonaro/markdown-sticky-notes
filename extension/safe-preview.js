// Safe, deterministic previews for formats that are not Markdown.
//
// HTML never reaches a browser or WebKit. This tokenizer ignores every
// attribute, drops active elements with their contents and emits only Pango
// markup created below. User text is always escaped before entering markup.

const BLOCKED = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math',
    'canvas', 'video', 'audio', 'source', 'track', 'link', 'meta',
    'base', 'form', 'input', 'button', 'textarea', 'select', 'option',
    'frame', 'frameset', 'template', 'applet',
]);

const BLOCKS = new Set([
    'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dt', 'dd',
    'fieldset', 'figcaption', 'figure', 'footer', 'header', 'main', 'nav',
    'li', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'thead',
    'tfoot', 'tr', 'ul', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

const STYLES = new Map([
    ['b', ['b']],
    ['strong', ['b']],
    ['i', ['i']],
    ['em', ['i']],
    ['u', ['u']],
    ['s', ['s']],
    ['strike', ['s']],
    ['del', ['s']],
    ['code', ['tt']],
    ['kbd', ['tt']],
    ['samp', ['tt']],
    ['h1', ['b', 'big']],
    ['h2', ['b', 'big']],
    ['h3', ['b']],
    ['h4', ['b']],
    ['h5', ['b']],
    ['h6', ['b']],
    // Links are visual text only. href and every other attribute are ignored.
    ['a', ['u']],
]);

function escapePango(text) {
    return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function decodeEntities(text) {
    const named = {
        amp: '&',
        apos: "'",
        gt: '>',
        lt: '<',
        nbsp: '\u00a0',
        quot: '"',
    };
    return String(text).replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (whole, entity) => {
        if (entity[0] !== '#')
            return named[entity.toLowerCase()] ?? whole;
        const hex = entity[1]?.toLowerCase() === 'x';
        const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff ||
            (value >= 0xd800 && value <= 0xdfff))
            return '\ufffd';
        return String.fromCodePoint(value);
    });
}

function parseTag(token) {
    const match = token.match(/^<\s*(\/?)\s*([a-z][\w:-]*)([\s\S]*?)(\/?)\s*>$/i);
    if (!match)
        return null;
    return {
        closing: match[1] === '/',
        name: match[2].toLowerCase(),
        attributes: match[3] ?? '',
        selfClosing: match[4] === '/',
    };
}

function altText(attributes) {
    const match = attributes.match(
        /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

function styledMarkup(text, activeStyles) {
    let markup = escapePango(text);
    const styles = activeStyles.flatMap(entry => entry.styles);
    for (let index = styles.length - 1; index >= 0; index--)
        markup = `<${styles[index]}>${markup}</${styles[index]}>`;
    return markup;
}

function createRenderer() {
    const rows = [];
    let parts = [];
    let plain = '';
    const activeStyles = [];
    let preDepth = 0;

    const append = raw => {
        let text = decodeEntities(raw);
        if (!preDepth)
            text = text.replace(/\s+/g, ' ');
        if (!text)
            return;
        if (!preDepth && (!plain || plain.endsWith(' ')))
            text = text.replace(/^ +/, '');
        if (!text)
            return;
        parts.push(styledMarkup(text, activeStyles));
        plain += text;
    };
    const newline = force => {
        const normalized = plain.replace(/[ \t]+$/g, '');
        if (normalized || force) {
            rows.push({
                kind: preDepth ? 'block' : 'text',
                pango: parts.join('').replace(/[ \t]+(?=<|$)/g, ''),
                plain: normalized,
                links: [],
            });
        }
        parts = [];
        plain = '';
    };
    const openStyle = name => {
        const styles = STYLES.get(name);
        if (styles)
            activeStyles.push({name, styles});
    };
    const closeStyle = name => {
        for (let index = activeStyles.length - 1; index >= 0; index--) {
            if (activeStyles[index].name === name) {
                activeStyles.splice(index, 1);
                break;
            }
        }
    };
    return {
        rows,
        append,
        newline,
        openStyle,
        closeStyle,
        get hasText() {
            return plain.length > 0;
        },
        get preDepth() {
            return preDepth;
        },
        set preDepth(value) {
            preDepth = Math.max(0, value);
        },
    };
}

export function renderPlainText(source) {
    const lines = String(source ?? '').split(/\r?\n/);
    return {
        rows: lines.map(line => ({
            kind: 'text',
            pango: escapePango(line),
            plain: line,
            links: [],
        })),
    };
}

export function renderSafeHtml(source) {
    const renderer = createRenderer();
    const blocked = [];
    const tokens = String(source ?? '').match(
        /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>]*>|[^<]+|</gi) ?? [];

    for (const token of tokens) {
        if (token.startsWith('<!--') || /^<!/i.test(token))
            continue;
        const tag = token.startsWith('<') ? parseTag(token) : null;
        if (blocked.length) {
            if (!tag)
                continue;
            if (!tag.closing && BLOCKED.has(tag.name) && !tag.selfClosing) {
                blocked.push(tag.name);
            } else if (tag.closing && tag.name === blocked.at(-1)) {
                blocked.pop();
            }
            continue;
        }
        if (!tag) {
            renderer.append(token);
            continue;
        }
        if (BLOCKED.has(tag.name)) {
            if (!tag.closing && !tag.selfClosing)
                blocked.push(tag.name);
            continue;
        }
        if (tag.closing) {
            renderer.closeStyle(tag.name);
            if (tag.name === 'pre')
                renderer.preDepth -= 1;
            if (BLOCKS.has(tag.name))
                renderer.newline(false);
            continue;
        }
        if (tag.name === 'br') {
            renderer.newline(true);
            continue;
        }
        if (tag.name === 'hr') {
            renderer.newline(false);
            renderer.append('────────');
            renderer.newline(false);
            continue;
        }
        if (BLOCKS.has(tag.name) && renderer.hasText)
            renderer.newline(false);
        if (tag.name === 'li')
            renderer.append('• ');
        else if (tag.name === 'blockquote')
            renderer.append('› ');
        else if (tag.name === 'img') {
            const alt = altText(tag.attributes);
            renderer.append(alt ? `[${alt}]` : '[image]');
        }
        if (tag.name === 'pre')
            renderer.preDepth += 1;
        renderer.openStyle(tag.name);
        if (tag.selfClosing) {
            renderer.closeStyle(tag.name);
            if (tag.name === 'pre')
                renderer.preDepth -= 1;
        }
    }
    renderer.newline(false);
    return {rows: renderer.rows};
}
