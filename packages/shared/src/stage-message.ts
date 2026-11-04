import type { StageContextDTO } from './dto';

export interface StageChangeMessageInput {
  ticketKey: string;
  /** Name of the stage before the change; null when the session is just starting or resuming. */
  fromStageName: string | null;
  /** null when every stage is finished. */
  stage: StageContextDTO | null;
  /** Why the change happened, shown to Claude (e.g. "the user confirmed your proposal"). */
  cause: string;
}

/**
 * The user-visible message Shipline posts into the ticket's single Claude conversation whenever the
 * stage changes (and when a session starts or resumes). Stage-specific rules are delivered this way
 * instead of restarting Claude; the server enforces the stage's tool policy independently.
 */
export function buildStageChangeMessage(input: StageChangeMessageInput): string {
  const { ticketKey, fromStageName, stage, cause } = input;
  if (!stage) {
    return `[Shipline] ${ticketKey}: every stage is finished (${cause}). Nothing further to do unless the user asks.`;
  }
  const lines = [
    `[Shipline] ${ticketKey}: ${fromStageName ? `stage changed from ${fromStageName} to ${stage.name}` : `current stage is ${stage.name}`} (${cause}).`,
  ];
  lines.push(`Stage instructions: ${stage.instructions}`);
  if (stage.agentName) {
    lines.push(`This stage names the "${stage.agentName}" agent: delegate the stage's work to it (if it is not available, do the work yourself).`);
  }
  lines.push(
    `Expected artifact type(s): ${stage.artifactTypes.join(', ')}. When it is ready, call submit_artifact, then call propose_stage_transition with kind "complete" and wait for the user to confirm.`,
  );
  lines.push(
    stage.toolPolicy.allowCodeEdit
      ? 'Code edits are allowed in this stage (subject to the permission prompts).'
      : 'Code edits are NOT allowed in this stage; the server will deny them.',
  );
  if (stage.optional) {
    lines.push(
      'This stage is optional: if it is not needed, explain why and call propose_stage_transition with kind "skip".',
    );
  }
  lines.push('If a tool call is denied (by a guardrail rule, the stage or the user\'s role), do not work around it; tell the user what was denied and why.');
  return lines.join('\n');
}

/** Message posted when the user answers "Not yet" to a proposal. */
export function buildDeclinedMessage(ticketKey: string, kind: string, stageName: string): string {
  return `[Shipline] ${ticketKey}: the user declined your proposal to ${kind} the ${stageName} stage ("Not yet"). Stay in ${stageName} and continue; ask what is missing if unclear.`;
}

export interface TemplateSwitchMessageInput {
  ticketKey: string;
  fromTemplateName: string;
  toTemplateName: string;
  toVersion: number;
  /** Stage names of the new template, in order. */
  stageNames: string[];
  /** Stages carried over as done. */
  carriedOver: string[];
}

/** Message posted when the user confirms a template switch; the stage message follows it. */
export function buildTemplateSwitchMessage(input: TemplateSwitchMessageInput): string {
  const carried = input.carriedOver.length > 0 ? ` Already done and carried over: ${input.carriedOver.join(', ')}.` : '';
  return `[Shipline] ${input.ticketKey}: the user confirmed switching this chat from the ${input.fromTemplateName} template to ${input.toTemplateName} (v${input.toVersion}). Stages, in order: ${input.stageNames.join(' > ')}.${carried}`;
}

/** Message posted when the user answers "Not yet" to a template switch proposal. */
export function buildTemplateSwitchDeclinedMessage(ticketKey: string, toTemplateName: string, currentTemplateName: string): string {
  return `[Shipline] ${ticketKey}: the user declined your proposal to switch to the ${toTemplateName} template ("Not yet"). Stay on ${currentTemplateName} and continue.`;
}
