// A deliberately small, safe Pango-markup preview for common Markdown.
// All user content is escaped; markup is generated only by our own renderer.
// The editable source remains the original Markdown string.
function escapePango(text) {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function inline(source) {
    // Non-nested Markdown spans; unmatched delimiters remain literal.
    const tokens = /(\`[^\`\n]+\`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^\)\n]*\))/g;
    let result = '';
    let previous = 0;
    for (const match of source.matchAll(tokens)) {
        result += escapePango(source.slice(previous, match.index));
        const token = match[0];
        if (token.startsWith('**') || token.startsWith('__'))
            result += `<b>${escapePango(token.slice(2, -2))}</b>`;
        else if (token.startsWith('~~'))
            result += `<s>${escapePango(token.slice(2, -2))}</s>`;
        else if (token.startsWith('\`'))
            result += `<tt>${escapePango(token.slice(1, -1))}</tt>`;
        else if (token.startsWith('['))
            result += `<u>${escapePango(token.slice(1, token.indexOf(']')))}</u>`;
        else
            result += `<i>${escapePango(token.slice(1, -1))}</i>`;
        previous = match.index + token.length;
    }
    return result + escapePango(source.slice(previous));
}

export function renderMarkdown(source) {
    let fenced = false;
    return source.replace(/\r\n/g, '\n').split('\n').map(line => {
        if (/^\s*\`\`\`/.test(line)) {
            fenced = !fenced;
            return '';
        }
        if (fenced)
            return `<tt>${escapePango(line)}</tt>`;
        const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
        if (heading) {
            const size = heading[1].length <= 2 ? 'x-large' : 'large';
            return `<span weight="bold" size="${size}">${inline(heading[2])}</span>`;
        }
        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line))
            return '────────────────';
        const box = line.match(/^(\s*)[-*+]\s+\[([xX ])\]\s+(.*)$/);
        if (box)
            return `${escapePango(box[1])}${box[2] === ' ' ? '☐' : '☑'}  ${inline(box[3])}`;
        const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
        if (bullet)
            return `${escapePango(bullet[1])}•  ${inline(bullet[2])}`;
        return inline(line);
    }).join('\n');
}
