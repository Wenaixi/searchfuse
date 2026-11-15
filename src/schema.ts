// 通过结构化输出在引擎上强制执行的 JSON schema。
// 数值型相关度分数已移除：模型会编造它们，而条目顺序本身已经承载了排序。

export const SEARCH_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          snippet: { type: 'string' },
          source: { type: 'string' },
          published_at: { type: 'string' },
          // 只出现在融合结果里：哪些引擎返回过这个页面。
          // 链式运行只由一个引擎作答，所以那里没有这个字段，
          // 而不是给一个长度为 1 的列表。
          foundIn: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'url', 'snippet'],
      },
    },
    uncertainty: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'items', 'uncertainty'],
} as const;

export const FETCH_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    content: { type: 'string' },
    links: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['text', 'url'],
      },
    },
    uncertainty: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'content', 'uncertainty'],
} as const;

export function searchResultSchemaJson(): string {
  return JSON.stringify(SEARCH_RESULT_SCHEMA);
}

export function fetchResultSchemaJson(): string {
  return JSON.stringify(FETCH_RESULT_SCHEMA);
}
