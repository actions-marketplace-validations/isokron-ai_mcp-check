export const TOOLS = [
  { name: 'get_item', description: 'Returns an item.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Id' } }, required: ['id'] }, annotations: { readOnlyHint: true } },
  { name: 'touch_item', description: 'Marks an item as seen.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Id' } }, required: ['id'] }, annotations: { readOnlyHint: true } },
  { name: 'delete_item', description: 'Removes an item.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Id' } }, required: ['id'] }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'count_items', description: 'Counts items.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
];
