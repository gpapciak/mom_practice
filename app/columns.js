/**
 * Column order for the data endpoint. GENERATED - do not edit by hand.
 *
 * Source of truth is the schema contract kept with the design docs; this file is
 * regenerated from it by tools/gen_app_columns.py. Names only, in order: the
 * endpoint aligns rows by column name, so order here must match the contract and
 * nothing may be inserted in the middle.
 */

/** schema_version 1, revision 1.5-pre-collection */
export const TRIAL_COLUMNS = [
  'trial_uid', 'schema_version', 'app_version', 'device_id', 'session_uid',
  'session_seq', 'session_date_local', 'session_start_utc', 'tz_offset_min',
  'days_since_prev_session', 'company_reported', 'audio_enabled',
  'speech_outcome', 'config_version', 'trial_index', 'stage',
  'stage_trial_index', 'ms_since_session_start', 'probe_id',
  'probe_version', 'condition', 'foil_type', 'item_id', 'item_concept_id',
  'item_category', 'item_domain', 'choice_order', 'target_position',
  'presented_at_utc', 'tested_at_utc', 'delay_arm', 'delay_nominal_ms',
  'delay_actual_ms', 'response', 'correct', 'outcome_flag', 'metacog',
  'metacog_latency_ms', 'decision_latency_ms', 'travel_latency_ms',
  'response_latency_ms', 'mouse_start_x', 'mouse_start_y', 'click_x',
  'click_y', 'travel_path_px', 'n_mousemove_samples', 'foreperiod_ms',
  'stimulus_side', 'viewport_w', 'viewport_h', 'dpr',
  'visual_viewport_scale', 'stage_px', 'hidden_ms', 'rng_seed',
  'concept_prior_exposures', 'concept_days_since_last', 'item_source',
  'choice_sources', 'pre_trial_interruption_ms', 'pre_trial_interruption_n',
];

export const TRIAL_SCHEMA_VERSION = 1;

/** schema_version 1, revision 1.3-pre-collection */
export const SESSION_COLUMNS = [
  'session_uid', 'schema_version', 'app_version', 'device_id',
  'session_seq', 'session_date_local', 'opened_at_utc',
  'start_pressed_at_utc', 'ended_at_utc', 'ms_open_before_start',
  'total_ms', 'hidden_total_ms', 'end_reason', 'last_stage_reached',
  'n_trials', 'days_since_prev_session', 'company_reported',
  'audio_enabled', 'greeting_speech_fired', 'speech_voices_n',
  'config_version', 'tz_offset_min', 'local_time_of_day', 'viewport_w',
  'viewport_h', 'dpr', 'visual_viewport_scale', 'stage_px',
  'zoom_drift_flag', 'screen_w', 'screen_h', 'ua_string',
  'storage_persisted', 'uploaded_at_utc', 'batch_id', 'speech_voice',
];

export const SESSION_SCHEMA_VERSION = 1;

/** Columns the endpoint must store as literal text rather than coerce. */
export const TEXT_COLUMNS = ['session_date_local', 'local_time_of_day'];
