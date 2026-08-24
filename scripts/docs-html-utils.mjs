export function plainTextFromHeadingHtml(headingHtml) {
  const anchorEnd = headingHtml.startsWith('<a class="anchor"') ? headingHtml.indexOf('</a>') : -1;
  const content = anchorEnd === -1 ? headingHtml : headingHtml.slice(anchorEnd + '</a>'.length);
  return stripHtmlTags(content).trim();
}

function stripHtmlTags(value) {
  let output = '';
  let inTag = false;
  let quote = '';

  for (const character of value) {
    if (!inTag) {
      if (character === '<') {
        inTag = true;
      } else {
        output += character;
      }
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      inTag = false;
    }
  }

  return output;
}
