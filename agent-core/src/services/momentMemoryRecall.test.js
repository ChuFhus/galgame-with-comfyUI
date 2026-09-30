import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { recallMomentMemories, formatMomentMemories } from './momentMemoryRecall.js';

const scope = ['char-7'];

function useMemory(enabled) {
  const original = config.features.memory;
  config.features.memory = enabled;
  return () => {
    config.features.memory = original;
  };
}

test('记忆特性关闭时不发起检索', async () => {
  const restore = useMemory(false);
  let calls = 0;
  try {
    const memories = await recallMomentMemories(scope, { postText: '今天天气不错' }, {
      hybridSearch: async () => {
        calls += 1;
        return [];
      },
    });
    assert.deepEqual(memories, []);
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test('无查询词时不发起检索', async () => {
  const restore = useMemory(true);
  let calls = 0;
  try {
    const memories = await recallMomentMemories(scope, {}, {
      hybridSearch: async () => {
        calls += 1;
        return [];
      },
    });
    assert.deepEqual(memories, []);
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test('无会话范围时不发起检索', async () => {
  const restore = useMemory(true);
  let calls = 0;
  try {
    const memories = await recallMomentMemories([], { postText: '今天天气不错' }, {
      hybridSearch: async () => {
        calls += 1;
        return [];
      },
    });
    assert.deepEqual(memories, []);
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test('分别以朋友圈文案与评论区内容检索发帖人的记忆，并按 memory_id 合并去重', async () => {
  const restore = useMemory(true);
  const calls = [];
  const fakeSearch = async (query, options) => {
    calls.push({ query, options });
    if (query === '今天天气不错') {
      return [
        { memory_id: 1, memory_type: '偏好', judgment: '喜欢晴天' },
        { memory_id: 2, memory_type: '关系', judgment: '和用户关系很好' },
      ];
    }
    return [
      { memory_id: 2, memory_type: '关系', judgment: '和用户关系很好' },
      { memory_id: 3, memory_type: '事件', judgment: '一起去过海边' },
    ];
  };
  try {
    const memories = await recallMomentMemories(scope, {
      postText: '今天天气不错',
      commentText: ['好久没见了', '最近在忙什么'],
    }, { hybridSearch: fakeSearch });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].query, '今天天气不错');
    assert.equal(calls[1].query, '好久没见了 最近在忙什么');
    assert.deepEqual(calls[0].options.conversationIds, ['char-7']);
    assert.equal(calls[0].options.topk, 5);
    assert.deepEqual(memories.map((memory) => memory.memory_id), [1, 2, 3]);
  } finally {
    restore();
  }
});

test('过滤掉事件 / 奇遇 / 未互动事件类记忆', async () => {
  const restore = useMemory(true);
  try {
    const memories = await recallMomentMemories(scope, { postText: '海边' }, {
      hybridSearch: async () => ([
        { memory_id: 1, memory_type: '事件', judgment: '【事件】【奇遇】未互动事件：在海边遇到一只猫' },
        { memory_id: 2, memory_type: '事件', judgment: '【事件】在海边散步' },
      ]),
    });
    assert.deepEqual(memories.map((memory) => memory.memory_id), [2]);
  } finally {
    restore();
  }
});

test('检索抛错时返回空数组且不向外抛', async () => {
  const restore = useMemory(true);
  const originalError = console.error;
  console.error = () => {};
  try {
    const memories = await recallMomentMemories(scope, { postText: '海边' }, {
      hybridSearch: async () => {
        throw new Error('boom');
      },
    });
    assert.deepEqual(memories, []);
  } finally {
    console.error = originalError;
    restore();
  }
});

test('检索超时按无结果处理', async () => {
  const restore = useMemory(true);
  try {
    const memories = await recallMomentMemories(scope, { postText: '海边' }, {
      hybridSearch: () => new Promise(() => {}),
      timeoutMs: 20,
    });
    assert.deepEqual(memories, []);
  } finally {
    restore();
  }
});

test('formatMomentMemories 输出「发帖人经历过的事情」注入块', () => {
  const block = formatMomentMemories([
    { memory_type: '偏好', judgment: '喜欢晴天' },
    { memory_type: '关系', judgment: '和用户关系很好' },
  ], '小明');
  assert.equal(
    block,
    '<rag_memories>\n小明经历过的事情：\n1. [偏好] 喜欢晴天\n2. [关系] 和用户关系很好\n</rag_memories>',
  );
});

test('formatMomentMemories 名字缺失时兜底为 TA', () => {
  const block = formatMomentMemories([{ memory_type: '偏好', judgment: '喜欢晴天' }], '');
  assert.equal(
    block,
    '<rag_memories>\nTA经历过的事情：\n1. [偏好] 喜欢晴天\n</rag_memories>',
  );
});
