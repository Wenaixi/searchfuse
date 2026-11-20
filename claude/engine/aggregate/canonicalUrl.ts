/**
 * 两个引擎对同一个页面必须达成一致的那个 URL。
 *
 * 融合层用这个键去重。这里被去掉的东西，都是不改变页面内容的：片段标识
 * 从不选中另一份文档，追踪参数是分享链接的人追加的，参数顺序只是 URL 拼装
 * 过程的偶然产物。**故意不**去掉的是 `www.` 前缀和路径大小写——它们确实
 * 经常指向不同页面，合并它们会悄悄丢掉一个真实的第二来源，那比同一个页面
 * 出现两次更糟。
 *
 * 无法解析的输入原样返回。某个提供方给了坏 URL，不该中断整个搜索；
 * 它的条目以自己的拼写继续可见。
 */
const TRACKING_PARAMETERS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'source',
  'spm',
]);

function isTracking(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMETERS.has(lower);
}

export function canonicalUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return raw;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return raw;
  }

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  // 把端口设成空串会去掉显式写出的默认端口、保留非默认端口，
  // 这正是 URL API 自身的行为。
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }

  const kept: Array<[string, string]> = [];
  for (const [name, value] of url.searchParams) {
    if (!isTracking(name)) {
      kept.push([name, value]);
    }
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  const query = new URLSearchParams();
  for (const [name, value] of kept) {
    query.append(name, value);
  }
  url.search = query.toString();

  let out = url.toString();
  // 非根路径的尾斜杠指向同一页面；根路径的那个斜杠是地址的一部分。
  if (url.pathname !== '/' && out.endsWith('/')) {
    out = out.slice(0, -1);
  }
  return out;
}
