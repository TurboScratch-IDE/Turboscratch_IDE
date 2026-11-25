/* eslint-disable valid-jsdoc */

const isHighSurrogate = code => code >= 0xD800 && code <= 0xDBFF;

/** Shortens text to at most max characters (plus …) without cutting an emoji in half. */
const clipText = (value, max) => {
    const text = String(value);
    if (text.length <= max) return text;
    let end = max;
    if (isHighSurrogate(text.charCodeAt(end - 1))) end--;
    return `${text.slice(0, end)}…`;
};

export {
    clipText
};
