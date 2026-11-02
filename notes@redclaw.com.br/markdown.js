// Small, dependency-free Markdown preview for GNOME Shell's Pango text renderer.
// The .md file remains the source of truth; previews never rewrite it.

function escapeMarkup(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function inlineMarkdown(text) {
    let result = escapeMarkup(text);
    // Supported inline syntax: code, links (display-only), bold, italic, strike.
    result = result.replace(/`([^`]+)`/g, '<tt>$1</tt>');
    result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<u>$1</u> ($2)');
    result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    result = result.replace(/__(.+?)__/g, '<b>$1</b>');
    result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');
    result = result.replace(/(^|\W)\*([^*]+)\*/g, '$1<i>$2</i>');
    result = result.replace(/(^|\W)_([^_]+)_/g, '$1<i>$2</i>');
    return result;
}

export function renderMarkdown(markdown) {
    let inCodeBlock = false;
    return markdown.split('\n').map(line => {
        if (/^\s*```/.test(line)) {
            inCodeBlock = !inCodeBlock;
            return '';
        }
        if (inCodeBlock)
            return `<tt>${escapeMarkup(line)}</tt>`;

        const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
        if (heading) {
            const size = heading[1].length <= 2 ? 'x-large' : 'large';
            return `<span size="${size}" weight="bold">${inlineMarkdown(heading[2])}</span>`;
        }
        const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
        if (bullet)
            return `• ${inlineMarkdown(bullet[1])}`;
        const numbered = line.match(/^\s*(\d+\.)\s+(.+)$/);
        if (numbered)
            return `${numbered[1]} ${inlineMarkdown(numbered[2])}`;
        const quote = line.match(/^\s*>\s?(.*)$/);
        if (quote)
            return `<i>│ ${inlineMarkdown(quote[1])}</i>`;
        if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line))
            return '────────────────────';
        return inlineMarkdown(line);
    }).join('\n');
}
