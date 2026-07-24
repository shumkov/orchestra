'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { canonicalizeToolInput } = require('../canonical-json');

const TASK_NOTIFICATION_ID_RE = /<tool-use-id>\s*([^<]+?)\s*<\/tool-use-id>/g;

function normalizeVisibleText(value) {
  return typeof value === 'string'
    ? value.replace(/\r\n?/g, '\n').trim()
    : '';
}

function hashText(value) {
  return crypto.createHash('sha256').update(normalizeVisibleText(value), 'utf8').digest('hex');
}

function normalizedToolName(name) {
  if (name === 'reply' || /__reply$/.test(name || '')) return 'reply';
  if (name === 'edit_message' || /__edit_message$/.test(name || '')) return 'edit_message';
  return null;
}

function hashDeliveryArguments(name, input = {}) {
  const toolName = normalizedToolName(name);
  if (!toolName) return null;
  const value = {
    tool: toolName,
    chat_id: input.chat_id == null ? null : String(input.chat_id),
    message_id: toolName === 'edit_message' && input.message_id != null
      ? String(input.message_id)
      : null,
    interim: toolName === 'reply' && input.interim === true,
    text: normalizeVisibleText(input.text),
    files: Array.isArray(input.files) ? input.files.map(file => String(file)) : [],
  };
  return crypto.createHash('sha256').update(canonicalizeToolInput(value), 'utf8').digest('hex');
}

function textFromMessage(message) {
  if (!message) return { text: '', toolResultOnly: false, invalid: true };
  if (typeof message.content === 'string') {
    return { text: message.content, toolResultOnly: false, invalid: false };
  }
  if (!Array.isArray(message.content)) {
    return { text: '', toolResultOnly: false, invalid: true };
  }
  const texts = [];
  let hasToolResult = false;
  let hasOther = false;
  for (const block of message.content) {
    if (!block || typeof block !== 'object') {
      hasOther = true;
    } else if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (block.type === 'tool_result') {
      hasToolResult = true;
    } else {
      hasOther = true;
    }
  }
  return {
    text: texts.join('\n\n'),
    toolResultOnly: hasToolResult && texts.length === 0 && !hasOther,
    invalid: hasOther || (hasToolResult && texts.length > 0),
  };
}

function parseToolResult(block) {
  let value = block?.content;
  if (Array.isArray(value)) {
    const textBlocks = value.filter(item => item?.type === 'text' && typeof item.text === 'string');
    if (textBlocks.length !== value.length) return null;
    value = textBlocks.map(item => item.text).join('');
  }
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function result(reason, extra = {}) {
  return {
    eligible: false,
    reason,
    deliveredFinal: false,
    visibleHashes: [],
    unresolvedAttempts: [],
    ...extra,
  };
}

async function readSnapshot(filePath, byteSize) {
  if (typeof filePath !== 'string' || !filePath || !Number.isSafeInteger(byteSize) || byteSize <= 0) {
    return { ok: false, reason: 'snapshot-missing' };
  }
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.allocUnsafe(byteSize);
    let offset = 0;
    while (offset < byteSize) {
      const { bytesRead } = await handle.read(buffer, offset, byteSize - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== byteSize) return { ok: false, reason: 'snapshot-truncated' };
    if (buffer[byteSize - 1] !== 0x0a) return { ok: false, reason: 'partial-line' };
    return { ok: true, text: buffer.toString('utf8') };
  } catch {
    return { ok: false, reason: 'snapshot-unreadable' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function collectToolReceipts(branch) {
  const toolUses = new Map();
  const toolResults = new Map();
  let ordinal = 0;

  for (const row of branch) {
    if (row.type === 'assistant' && Array.isArray(row.message?.content)) {
      for (const block of row.message.content) {
        const blockOrdinal = ordinal++;
        const toolName = normalizedToolName(block?.name);
        if (block?.type !== 'tool_use' || !toolName) continue;
        if (typeof block.id !== 'string' || !block.id || toolUses.has(block.id)) {
          return { ok: false, reason: 'delivery-tool-ambiguous' };
        }
        const argumentHash = hashDeliveryArguments(toolName, block.input);
        if (!argumentHash) return { ok: false, reason: 'delivery-arguments-invalid' };
        toolUses.set(block.id, {
          id: block.id,
          toolName,
          input: block.input || {},
          argumentHash,
        });
      }
    }
    if (row.type === 'user' && Array.isArray(row.message?.content)) {
      for (const block of row.message.content) {
        const blockOrdinal = ordinal++;
        if (block?.type !== 'tool_result' || !toolUses.has(block.tool_use_id)) continue;
        if (toolResults.has(block.tool_use_id)) {
          return { ok: false, reason: 'delivery-result-ambiguous' };
        }
        toolResults.set(block.tool_use_id, {
          receipt: parseToolResult(block),
          ordinal: blockOrdinal,
        });
      }
    }
  }

  const delivered = [];
  const failuresByAttempt = new Map();
  const attemptIds = new Set();
  for (const toolUse of toolUses.values()) {
    const toolResult = toolResults.get(toolUse.id);
    if (!toolResult?.receipt) return { ok: false, reason: 'delivery-result-missing' };
    const { receipt, ordinal: resultOrdinal } = toolResult;
    if (typeof receipt.attempt_id !== 'string' || !receipt.attempt_id) {
      return { ok: false, reason: 'delivery-attempt-missing' };
    }
    if (attemptIds.has(receipt.attempt_id)) {
      return { ok: false, reason: 'delivery-attempt-ambiguous' };
    }
    attemptIds.add(receipt.attempt_id);
    if (receipt.ok === true) {
      if (receipt.delivery !== 'sent' && receipt.delivery !== 'replayed') {
        return { ok: false, reason: 'delivery-discriminator-missing' };
      }
      delivered.push({ toolUse, receipt, resultOrdinal });
    } else if (receipt.ok === false) {
      failuresByAttempt.set(receipt.attempt_id, { toolUse, receipt, resultOrdinal });
    } else {
      return { ok: false, reason: 'delivery-result-invalid' };
    }
  }

  let deliveredFinal = false;
  const visibleHashes = new Set();
  const linkedReplaySources = new Set();

  for (const item of delivered) {
    const { toolUse, receipt, resultOrdinal } = item;
    let provesDelivery = receipt.delivery === 'sent';
    if (receipt.delivery === 'replayed') {
      if (typeof receipt.replay_of !== 'string' || !receipt.replay_of) {
        return { ok: false, reason: 'delivery-replay-source-missing' };
      }
      const source = failuresByAttempt.get(receipt.replay_of);
      if (source && source.resultOrdinal >= resultOrdinal) {
        return { ok: false, reason: 'delivery-replay-order-invalid' };
      }
      provesDelivery = !!source
        && source.toolUse.toolName === toolUse.toolName
        && source.toolUse.argumentHash === toolUse.argumentHash;
      if (provesDelivery) linkedReplaySources.add(receipt.replay_of);
    }
    if (!provesDelivery) continue;
    if (toolUse.toolName === 'reply' && toolUse.input.interim !== true) {
      deliveredFinal = true;
    } else {
      visibleHashes.add(hashText(toolUse.input.text));
    }
  }

  const unresolvedAttempts = [];
  for (const [attemptId, item] of failuresByAttempt) {
    if (linkedReplaySources.has(attemptId) || item.receipt.timeout !== true) continue;
    unresolvedAttempts.push({
      attemptId,
      argumentHash: item.toolUse.argumentHash,
      finalReply: item.toolUse.toolName === 'reply' && item.toolUse.input.interim !== true,
      visibleHash: hashText(item.toolUse.input.text),
    });
  }

  return {
    ok: true,
    deliveredFinal,
    visibleHashes: [...visibleHashes],
    unresolvedAttempts,
  };
}

async function correlateWorkflowCompletionSnapshot({
  transcriptPath,
  byteSize,
  sessionId,
  finalText,
} = {}) {
  const normalizedFinal = normalizeVisibleText(finalText);
  if (!normalizedFinal) return result('final-empty');
  if (typeof sessionId !== 'string' || !sessionId) return result('session-missing');

  const snapshot = await readSnapshot(transcriptPath, byteSize);
  if (!snapshot.ok) return result(snapshot.reason);

  const rows = [];
  const lines = snapshot.text.split('\n');
  lines.pop();
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    let row;
    try {
      row = JSON.parse(lines[index]);
    } catch {
      return result('json-invalid');
    }
    if (!row || typeof row !== 'object') return result('row-invalid');
    rows.push(row);
  }

  const mainline = rows.filter(row => (
    row.sessionId === sessionId
    && row.isSidechain === false
    && (row.type === 'assistant' || row.type === 'user')
  ));
  if (!mainline.length) return result('session-mainline-missing');

  const byUuid = new Map();
  const children = new Map();
  for (const row of mainline) {
    if (
      typeof row.uuid !== 'string'
      || !row.uuid
      || (row.parentUuid !== null && typeof row.parentUuid !== 'string')
    ) {
      return result('ancestry-field-missing');
    }
    if (byUuid.has(row.uuid)) return result('duplicate-uuid');
    byUuid.set(row.uuid, row);
    if (row.parentUuid) {
      const list = children.get(row.parentUuid) || [];
      list.push(row.uuid);
      children.set(row.parentUuid, list);
    }
  }

  let terminalIndex = -1;
  for (let index = mainline.length - 1; index >= 0; index--) {
    if (mainline[index].type === 'assistant') {
      terminalIndex = index;
      break;
    }
  }
  if (terminalIndex < 0) return result('terminal-missing');
  if (terminalIndex !== mainline.length - 1) return result('terminal-not-last-mainline');

  const terminal = mainline[terminalIndex];
  if (
    typeof terminal.requestId !== 'string' || !terminal.requestId
    || typeof terminal.message?.id !== 'string' || !terminal.message.id
  ) {
    return result('terminal-identity-missing');
  }

  const group = [terminal];
  for (let index = terminalIndex - 1; index >= 0; index--) {
    const prior = mainline[index];
    const first = group[0];
    if (
      prior.type !== 'assistant'
      || prior.sessionId !== terminal.sessionId
      || prior.requestId !== terminal.requestId
      || prior.message?.id !== terminal.message.id
    ) break;
    if (first.parentUuid !== prior.uuid) return result('terminal-fragment-chain-broken');
    group.unshift(prior);
  }

  if (terminal.message?.stop_reason !== 'end_turn') return result('terminal-not-end-turn');
  const terminalTexts = [];
  for (const row of group) {
    if (!Array.isArray(row.message?.content)) return result('terminal-content-invalid');
    for (const block of row.message.content) {
      if (block?.type === 'tool_use') return result('terminal-has-tool-use');
      if (block?.type === 'text') {
        if (typeof block.text !== 'string') return result('terminal-text-invalid');
        terminalTexts.push(block.text);
      } else if (block?.type !== 'thinking') {
        return result('terminal-block-invalid');
      }
    }
  }
  if (normalizeVisibleText(terminalTexts.join('\n\n')) !== normalizedFinal) {
    return result('final-mismatch');
  }

  const reversePath = [];
  const visited = new Set(group.map(row => row.uuid));
  let cursorUuid = group[0].parentUuid;
  let notification = null;
  while (cursorUuid) {
    if (visited.has(cursorUuid)) return result('ancestry-cycle');
    visited.add(cursorUuid);
    const row = byUuid.get(cursorUuid);
    if (!row) return result('ancestry-broken');
    reversePath.push(row);
    if ((children.get(row.uuid) || []).length > 1) return result('ancestry-fork');
    if (row.type === 'user') {
      const content = textFromMessage(row.message);
      if (content.invalid) return result('user-content-ambiguous');
      if (normalizeVisibleText(content.text)) {
        notification = row;
        break;
      }
      if (!content.toolResultOnly) return result('user-content-empty');
    } else if (row.type !== 'assistant') {
      return result('ancestry-row-ineligible');
    }
    cursorUuid = row.parentUuid;
  }
  if (!notification) return result('notification-missing');
  if (
    notification.origin?.kind !== 'task-notification'
    || notification.promptSource !== 'system'
    || notification.isSidechain !== false
  ) {
    return result('notification-provenance-invalid');
  }

  const notificationText = textFromMessage(notification.message).text;
  if (!notificationText.includes('<task-notification>')) {
    return result('notification-shape-invalid');
  }
  const notificationIds = [...notificationText.matchAll(TASK_NOTIFICATION_ID_RE)].map(match => match[1].trim());
  if (notificationIds.length !== 1 || !notificationIds[0]) {
    return result('notification-tool-id-ambiguous');
  }

  const workflowToolId = notificationIds[0];
  const workflowMatches = [];
  cursorUuid = notification.parentUuid;
  const launchVisited = new Set();
  while (cursorUuid) {
    if (launchVisited.has(cursorUuid)) return result('launch-ancestry-cycle');
    launchVisited.add(cursorUuid);
    const row = byUuid.get(cursorUuid);
    if (!row) return result('launch-ancestry-broken');
    if ((children.get(row.uuid) || []).length > 1) return result('launch-ancestry-fork');
    if (row.type === 'assistant' && Array.isArray(row.message?.content)) {
      for (const block of row.message.content) {
        if (block?.type === 'tool_use' && block.id === workflowToolId && block.name === 'Workflow') {
          workflowMatches.push(block);
        }
      }
    }
    cursorUuid = row.parentUuid;
  }
  if (workflowMatches.length !== 1) return result('workflow-tool-match-invalid');

  const branch = [notification, ...reversePath.slice(0, -1).reverse(), ...group];
  const receipts = collectToolReceipts(branch);
  if (!receipts.ok) return result(receipts.reason);

  return result('eligible', {
    eligible: true,
    finalHash: hashText(normalizedFinal),
    deliveredFinal: receipts.deliveredFinal,
    visibleHashes: receipts.visibleHashes,
    unresolvedAttempts: receipts.unresolvedAttempts,
  });
}

module.exports = {
  correlateWorkflowCompletionSnapshot,
  hashDeliveryArguments,
  normalizeVisibleText,
};
