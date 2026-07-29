'use strict';

const MAX_ATTACHMENT_SETTING_BYTES = 512;

function boundedSetting(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > MAX_ATTACHMENT_SETTING_BYTES
  ) {
    throw new TypeError(
      `Codex attachment ${label} must be a non-empty string of at most `
      + `${MAX_ATTACHMENT_SETTING_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

function parseCodexAttachmentSettings(source) {
  const model = boundedSetting(source?.model, 'model');
  if (!source || !Object.hasOwn(source, 'reasoningEffort')) {
    return Object.freeze({
      complete: false,
      effort: null,
      effortPresence: 'omitted',
      model,
    });
  }
  if (source.reasoningEffort === null) {
    return Object.freeze({
      complete: false,
      effort: null,
      effortPresence: 'null',
      model,
    });
  }
  return Object.freeze({
    complete: true,
    effort: boundedSetting(source.reasoningEffort, 'effort'),
    effortPresence: 'present',
    model,
  });
}

module.exports = {
  MAX_ATTACHMENT_SETTING_BYTES,
  parseCodexAttachmentSettings,
};
