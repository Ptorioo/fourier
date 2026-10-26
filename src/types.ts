export type Scalar = string | number | boolean;
export type Audio = Float32Array[];
export type Samples = Float32Array | Float64Array;
export interface MidiEvent { time: number; data: number[] }
export interface Tone { frequency_hz: number; level_dbfs?: number; phase_degrees?: number; channel?: number; on_seconds?: number; off_seconds?: number }
export interface Stimulus {
  kind?: string; frequency_hz?: number; level_dbfs?: number; noise_rms_dbfs?: number; seed?: number;
  at_seconds?: number; on_seconds?: number; off_seconds?: number; start_hz?: number; end_hz?: number;
  competitor_hz?: number; competitor_dbfs?: number; probe_dbfs?: number; probe_kind?: string;
  path?: string; midi?: MidiEvent[]; tones?: Tone[];
}
export interface AutomationEvent { time: number; parameters: Record<string, Scalar> }
export interface Controls { state_file?: string; save_state?: boolean; automation?: AutomationEvent[] }
export interface Case extends Controls { id: string; stimulus: Stimulus; parameters: Record<string, Scalar> }
export interface Plan extends Controls {
  schema_version: 1; plugin: string; plugin_name: string | null; native_host?: string; sample_rate: number; channels: number;
  duration: number; buffer_size: number; timeout_seconds: number; parameters: Record<string, Scalar>; cases: Case[];
}
export interface Identity { path: string; sha256: string; kind: string; bytes?: number; files?: { path: string; sha256: string }[] }
export interface Provenance { input_files: Record<string, string>; tool_source_sha256?: string; native_host_sha256?: string; native_host?: string }
export interface Parameter { value: Scalar; raw_value?: number; id?: string; name?: string; index?: number; automatable?: boolean; label?: string; range?: string; value_type?: string; valid_values?: Scalar[]; valid_values_truncated?: boolean }
export interface PluginInfo { name: string; is_instrument: boolean; reported_latency_samples: number; parameters: Record<string, Parameter> }
export interface Stats { peak_dbfs: number | null; rms_dbfs: number | null; dc: number; crest_db: number | null; full_scale_fraction: number; digital_silence: boolean }
export interface Metrics {
  input: Stats[]; output: Stats[]; analysis_channel: number; analysis_window_seconds: number[]; alignment: string;
  gain_db: number | null; thd_db: number | null; frequency_hz?: number; input_tone_peak_dbfs?: number | null;
  output_tone_peak_dbfs?: number | null; impulse_peak_lag_samples?: number; energy_before_output_peak_fraction?: number;
  raw_null_difference?: Stats[];
}
export interface Traces { spectrum: { hz: number; dbfs: number | null }[]; rms_envelope: { seconds: number; input_rms_dbfs: number | null; output_rms_dbfs: number | null }[]; conventions: string }
export interface Result {
  status: 'ok' | 'error'; plugin?: PluginInfo; versions?: Record<string, string>; elapsed_seconds?: number;
  input_sha256?: string; output_sha256?: string; input_frames?: number; output_frames?: number; metrics?: Metrics;
  initial_plugin?: PluginInfo; automation_readbacks?: { sample: number; parameters: Record<string, Parameter> }[];
  state_snapshot?: string; warnings?: string[]; error_type?: string; error?: string; exit_code?: number | null;
}
export interface Entry { id: string; status: 'running' | 'ok' | 'error'; result?: Result; artifacts?: Record<string, string> }
export interface State {
  schema_version: number; kind: string; fingerprint?: string; identity: Identity; provenance: Provenance;
  spec: Plan; status: 'running' | 'ok' | 'error'; cases: Entry[];
}
export interface Request extends Controls {
  operation: 'inspect' | 'render'; plugin: string; plugin_name?: string | null; native_host?: string; native_host_sha256?: string; output: string; parameters: Record<string, Scalar>;
  sample_rate?: number; channels?: number; duration?: number; buffer_size?: number; stimulus?: Stimulus;
}
export interface Evidence {
  source_name: string; artifact: string; sha256: string; claim: string; classification: string;
  target_sha256: string | null; binding: string; caution: string;
}
