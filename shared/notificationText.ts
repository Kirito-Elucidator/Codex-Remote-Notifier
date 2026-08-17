export const DEFAULT_DISPLAYABLE_NOTIFICATION_TITLE = 'Codex 需要你的注意';
export const DEFAULT_DISPLAYABLE_NOTIFICATION_BODY = '请返回 Codex 查看详情';

export interface DisplayableNotificationText {
  title: string;
  body: string;
  titleFiltered: boolean;
  bodyFiltered: boolean;
}

export function deriveDisplayableNotificationText(
  canonicalTitle: string,
  canonicalBody: string,
): DisplayableNotificationText {
  const title = filterDisplayableText(canonicalTitle);
  const body = filterDisplayableText(canonicalBody);
  return {
    title: title.value || DEFAULT_DISPLAYABLE_NOTIFICATION_TITLE,
    body: body.value || DEFAULT_DISPLAYABLE_NOTIFICATION_BODY,
    titleFiltered: title.filtered || title.value.length === 0,
    bodyFiltered: body.filtered || body.value.length === 0,
  };
}

function filterDisplayableText(value: string): { value: string; filtered: boolean } {
  let displayable = '';
  let filtered = false;

  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        displayable += value[index] + value[index + 1];
        index += 1;
      } else {
        filtered = true;
      }
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      filtered = true;
      continue;
    }
    if (unit === 0xfffd || !isXmlCharacter(unit)) {
      filtered = true;
      continue;
    }
    displayable += value[index];
  }

  return { value: displayable, filtered };
}

function isXmlCharacter(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd)
  );
}
