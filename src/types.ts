export type EngagementId = string;
export type TemplateId = string;

export interface IndexRow {
  engagementId: EngagementId;
  templateId: TemplateId | null; // null while unknown
  currentVersion: number | null; // null = unknown
  declinedThroughVersion: number; // 0 = never declined
  inProgress: { since: number } | null; // epoch ms
  versionObservedAt: number | null; // epoch ms of the event that last set currentVersion
  removed: boolean; // deleted or archived
}

interface EventBase {
  engagementId: EngagementId;
  occurredAt: number; // epoch ms
}

export interface EngagementCreated extends EventBase {
  type: 'EngagementCreated';
  templateId: TemplateId;
  version: number;
  source: 'new' | 'rollForward' | 'copy' | 'restore';
}

// Emitted on every natural file load; this is the drift check.
export interface EngagementLoaded extends EventBase {
  type: 'EngagementLoaded';
  templateId: TemplateId;
  version: number;
}

export interface ApplyRequested extends EventBase {
  type: 'ApplyRequested';
  from: number;
  to: number;
}

export interface ApplySucceeded extends EventBase {
  type: 'ApplySucceeded';
  from: number;
  to: number;
}

export interface ApplyFailed extends EventBase {
  type: 'ApplyFailed';
  from: number;
  to: number;
}

export interface Declined extends EventBase {
  type: 'Declined';
  throughVersion: number;
}

export interface EngagementRemoved extends EventBase {
  type: 'EngagementRemoved';
  reason: 'deleted' | 'archived';
}

export type IndexEvent =
  | EngagementCreated
  | EngagementLoaded
  | ApplyRequested
  | ApplySucceeded
  | ApplyFailed
  | Declined
  | EngagementRemoved;

export type Status =
  | { kind: 'removed' }
  | { kind: 'unknown' }
  | { kind: 'templateUnknown' } // template missing from the template store
  | { kind: 'upToDate' }
  | { kind: 'declined'; through: number } // hidden from pending
  | { kind: 'pending'; from: number; to: number } // from = currentVersion, ALWAYS
  | { kind: 'inProgress'; since: number; from: number; to: number };

// A row for an engagement the index has never seen: every field unknown.
export function emptyRow(engagementId: EngagementId): IndexRow {
  return {
    engagementId,
    templateId: null,
    currentVersion: null,
    declinedThroughVersion: 0,
    inProgress: null,
    versionObservedAt: null,
    removed: false,
  };
}
