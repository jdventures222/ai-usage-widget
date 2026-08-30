'use strict';

// Since the Fable launch, claude.ai no longer fills the legacy top-level
// seven_day_<model> fields for scoped models — they arrive as null. The
// per-model weekly limits are only present in the `limits` array as entries
// with kind "weekly_scoped" (see upstream issue #97). This compatibility
// normalizer maps those entries onto synthetic top-level fields. The provider
// presentation policy later selects Fable and intentionally discards all other
// scoped limits before anything reaches storage or the renderer.

/**
 * Derive the synthetic field key for a scoped model display name.
 * "Fable" -> "seven_day_fable".
 * @param {string} displayName
 * @returns {string}
 */
function scopedFieldKey(displayName) {
  return 'seven_day_' + String(displayName).toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/**
 * Map scoped weekly limits onto synthetic seven_day_<name> top-level fields.
 * Existing (non-null) top-level fields are never overwritten. Entries without
 * a scoped model display name or without a percent are ignored.
 *
 * @param {Object} data - Usage payload (mutated in place).
 * @returns {Object} the same data object.
 */
function normalizeUsageLimits(data) {
  if (!data || !Array.isArray(data.limits)) return data;
  for (const limit of data.limits) {
    if (!limit || limit.kind !== 'weekly_scoped' || limit.percent == null) continue;
    const displayName = limit.scope && limit.scope.model && limit.scope.model.display_name;
    if (!displayName) continue;
    const key = scopedFieldKey(displayName);
    if (data[key] != null) continue; // never overwrite an existing top-level field
    data[key] = {
      utilization: limit.percent,
      resets_at: limit.resets_at != null ? limit.resets_at : null,
    };
  }
  return data;
}

module.exports = { normalizeUsageLimits, scopedFieldKey };
