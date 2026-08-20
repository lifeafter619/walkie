/**
 * 最小 multipart/form-data 文本解析器：Gotify 官方示例用 `curl -F` 发 multipart，
 * Express 默认中间件与 workerd 的 URLSearchParams 分流都不认它。只取普通字段，
 * 文件部分仅占位为 undefined（兼容端点没有附件场景），不引入外部依赖。
 * 输入必须是完整读出的 body 文本（boundary 切分对流的分块边界不健壮）。
 */
export function parseMultipart(text: string, contentType: string): Record<string, unknown> {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!boundary) return {};
  const fields: Record<string, unknown> = {};
  for (const part of text.split(`--${boundary}`)) {
    const segment = part.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    if (!segment || segment === '--') continue;
    const separator = segment.indexOf('\r\n\r\n');
    const splitAt = separator === -1 ? segment.indexOf('\n\n') + 1 : separator + 4;
    if (splitAt <= 0) continue;
    const headers = segment.slice(0, separator === -1 ? segment.indexOf('\n\n') : separator);
    const value = segment.slice(splitAt).replace(/\r?\n$/, '');
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    if (!name) continue;
    const isFile = /filename="/i.test(headers);
    fields[name] = isFile ? undefined : value;
  }
  return fields;
}
