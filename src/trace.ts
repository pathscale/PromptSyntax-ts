/** Deterministic PS/Trace production from independently observable execution facts. */

export interface TraceProducerInput {
  format_version: string;
  turn: string;
  tier: string;
  mode: string;
  content_mode: string;
  venue: {
    id: string;
    capability_document: string;
    vendor_profile?: string;
  };
  coverage: {
    routing: string;
    assembly: string;
    inline_threshold_bytes: number;
    profile?: string;
  };
  inferences: InferenceInput[];
  boundaries: BoundaryInput[];
}

interface InferenceInput {
  id: string;
  kind: string;
  compiled_request_utf8: string;
  routing: RoutingInput;
}

interface RoutingInput {
  requested: string;
  policy: string;
  route: RouteStep[];
  attempts: Attempt[];
  non_entity_fill: unknown[];
  refusal?: RefusalFact;
}

interface RouteStep {
  ref: string;
  canonical: string;
  rule: string;
  ambiguity_surfaced: boolean;
}

interface Attempt {
  ref: string;
  bound?: string;
  outcome: string;
  reasons?: string[];
  measured?: unknown;
}

interface RefusalFact {
  reason: string;
  authority: string;
  triggering_step?: string;
  recourse: unknown;
  policy_decision_id?: string;
  policy_bundle?: string;
  policy_engine?: string;
}

interface BoundaryInput {
  id: string;
  tool: string;
  outcome: string;
  sent: unknown;
  received?: unknown;
  reason?: string;
  fill: unknown[];
  internal?: string;
  measured: unknown;
}

export interface TraceProducerError {
  code: string;
  pointer: string;
  message: string;
}

export class TraceProducerFailure extends Error {
  readonly details: TraceProducerError;

  constructor(details: TraceProducerError) {
    super(details.message);
    this.name = "TraceProducerFailure";
    this.details = details;
  }
}

/** Parse deterministic execution facts and emit one user-tier Prompt Trace. */
export function produceTraceJson(input: string): unknown {
  let parsed: TraceProducerInput;
  try {
    parsed = JSON.parse(input) as TraceProducerInput;
  } catch (error) {
    throw producerFailure(
      "TRACE_PRODUCER_INPUT_INVALID",
      "",
      `producer input is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return produceTrace(parsed);
}

/** Emit one Prompt Trace without receiving a transcript or expected output. */
export function produceTrace(input: TraceProducerInput): unknown {
  validateEnvelope(input);
  const eventIds = new Set<string>();
  const events: unknown[] = [];

  input.inferences.forEach((inference, index) => {
    if (eventIds.has(inference.id)) {
      throw producerFailure(
        "TRACE_PRODUCER_EVENT_ID_DUPLICATE",
        `/inferences/${index}/id`,
        "producer input repeats an event id",
      );
    }
    eventIds.add(inference.id);
    events.push(produceInference(inference, index));
  });
  input.boundaries.forEach((boundary, index) => {
    if (eventIds.has(boundary.id)) {
      throw producerFailure(
        "TRACE_PRODUCER_EVENT_ID_DUPLICATE",
        `/boundaries/${index}/id`,
        "producer input repeats an event id",
      );
    }
    eventIds.add(boundary.id);
    events.push(produceBoundary(boundary));
  });

  return {
    ps_trace: "0.3-draft",
    turn: input.turn,
    tier: input.tier,
    mode: input.mode,
    content_mode: input.content_mode,
    venue: input.venue,
    coverage: input.coverage,
    events,
  };
}

function validateEnvelope(input: TraceProducerInput): void {
  const valid =
    input.format_version === "0.1-draft" &&
    input.tier === "user" &&
    input.mode === "executed" &&
    input.content_mode === "tiered" &&
    input.coverage.routing === "complete" &&
    input.coverage.assembly === "user-initiated-only" &&
    input.coverage.inline_threshold_bytes >= 4096;
  if (!valid) {
    throw producerFailure(
      "TRACE_PRODUCER_INPUT_UNSUPPORTED",
      "",
      "producer supports only the 0.1-draft user-tier executed profile",
    );
  }
}

function produceInference(inference: InferenceInput, inferenceIndex: number): unknown {
  const base = `/inferences/${inferenceIndex}/routing`;
  if (inference.kind !== "user-initiated") {
    throw producerFailure(
      "TRACE_PRODUCER_INPUT_UNSUPPORTED",
      `/inferences/${inferenceIndex}/kind`,
      "producer supports only user-initiated inferences",
    );
  }
  if (inference.routing.route.length === 0 || inference.routing.attempts.length === 0) {
    throw producerFailure(
      "TRACE_PRODUCER_ROUTE_INVALID",
      base,
      "routing requires at least one route step and one attempt",
    );
  }

  const canonicalRoute = new Set<string>();
  inference.routing.route.forEach((step, index) => {
    if (canonicalRoute.has(step.canonical)) {
      throw producerFailure(
        "TRACE_PRODUCER_ROUTE_DUPLICATE",
        `${base}/route/${index}/canonical`,
        "authored route repeats a canonical entity",
      );
    }
    canonicalRoute.add(step.canonical);
  });

  const filled = inference.routing.attempts
    .map((attempt, index) => ({ attempt, index }))
    .filter(({ attempt }) => attempt.outcome === "filled");
  if (filled.length > 1) {
    throw producerFailure(
      "TRACE_PRODUCER_MULTIPLE_FILLED",
      `${base}/attempts`,
      "routing facts contain more than one filled attempt",
    );
  }

  const requestedEntity = inference.routing.route[0].canonical;
  let outcome: "invoked" | "refused";
  let bound: string | undefined;
  let entityFill: unknown;
  const resolutionRefusals: unknown[] = [];

  if (filled.length === 1) {
    const { attempt, index: attemptIndex } = filled[0];
    if (inference.routing.refusal !== undefined) {
      throw producerFailure(
        "TRACE_PRODUCER_REFUSAL_CONFLICT",
        `${base}/refusal`,
        "routing cannot contain both a filled attempt and a refusal fact",
      );
    }
    if (attemptIndex + 1 !== inference.routing.attempts.length) {
      throw producerFailure(
        "TRACE_PRODUCER_ATTEMPT_ORDER_INVALID",
        `${base}/attempts/${attemptIndex}`,
        "no routing attempt may follow the filled attempt",
      );
    }
    if (attempt.bound === undefined) {
      throw producerFailure(
        "TRACE_PRODUCER_INPUT_INVALID",
        `${base}/attempts/${attemptIndex}/bound`,
        "filled attempt has no bound entity",
      );
    }
    bound = attempt.bound;
    const routeIndex = inference.routing.route.findIndex((step) => step.canonical === bound);
    if (routeIndex === 0 && attemptIndex === 0) {
      entityFill = {
        kind: "entity",
        requested: requestedEntity,
        applied: bound,
        status: "kept",
        policy: inference.routing.policy,
      };
    } else if (routeIndex > 0 && routeIndex === attemptIndex) {
      validateFallbackPrefix(inference.routing, routeIndex, base);
      entityFill = {
        kind: "entity",
        requested: requestedEntity,
        applied: bound,
        status: "fallback",
        policy: inference.routing.policy,
        route_step: routeIndex,
      };
    } else if (routeIndex >= 0) {
      throw producerFailure(
        "TRACE_PRODUCER_ATTEMPT_ROUTE_MISMATCH",
        `${base}/attempts/${attemptIndex}`,
        "filled attempt does not align with its authored route step",
      );
    } else if (inference.routing.policy === "best-effort") {
      entityFill = {
        kind: "entity",
        requested: requestedEntity,
        applied: bound,
        status: "substituted",
        policy: "best-effort",
        reason: "ENTITY_SUBSTITUTED",
        deciding_authority: "venue-operations",
      };
    } else {
      throw producerFailure(
        "TRACE_PRODUCER_SUBSTITUTION_NOT_AUTHORIZED",
        `${base}/attempts/${attemptIndex}/bound`,
        "an applied entity outside the authored route requires best-effort policy",
      );
    }
    outcome = "invoked";
  } else {
    const refusal = inference.routing.refusal;
    if (refusal === undefined) {
      throw producerFailure(
        "TRACE_PRODUCER_REFUSAL_REQUIRED",
        `${base}/refusal`,
        "routing with no filled attempt requires a refusal fact",
      );
    }
    resolutionRefusals.push({
      ref: inference.routing.route[0].ref,
      reason: refusal.reason,
      authority: refusal.authority,
      recourse: refusal.recourse,
      ...(refusal.triggering_step === undefined
        ? {}
        : { triggering_step: refusal.triggering_step }),
      ...(refusal.policy_decision_id === undefined
        ? {}
        : { policy_decision_id: refusal.policy_decision_id }),
      ...(refusal.policy_bundle === undefined ? {} : { policy_bundle: refusal.policy_bundle }),
      ...(refusal.policy_engine === undefined ? {} : { policy_engine: refusal.policy_engine }),
    });
    entityFill = {
      kind: "entity",
      requested: requestedEntity,
      status: "refused",
      policy: inference.routing.policy,
      reason: refusal.reason,
      deciding_authority: refusal.authority,
    };
    outcome = "refused";
  }

  const routing = {
    requested: inference.routing.requested,
    policy: inference.routing.policy,
    outcome,
    ...(bound === undefined ? {} : { bound }),
    attempts: inference.routing.attempts,
    fill: [entityFill, ...inference.routing.non_entity_fill],
  };
  const bindings: unknown[] = inference.routing.route.map((step) => ({
    ref: step.ref,
    bound: step.canonical,
    rule: step.rule,
    ambiguity_surfaced: step.ambiguity_surfaced,
  }));
  if (bound !== undefined && !inference.routing.route.some((step) => step.canonical === bound)) {
    bindings.push({
      ref: bound,
      bound,
      rule: "venue-best-effort-substitution",
      ambiguity_surfaced: false,
    });
  }
  const stepId = `${inference.id}:step:user-content`;

  return {
    id: inference.id,
    event: "inference",
    kind: inference.kind,
    routing,
    segments: [
      {
        i: 0,
        id: `${inference.id}:segment:0`,
        origin: "user-authored",
        content: { state: "inline", text: inference.compiled_request_utf8 },
        step: stepId,
      },
    ],
    steps: [{ id: stepId, kind: "user-content", tier: "user" }],
    resolution: { bindings, refusals: resolutionRefusals },
  };
}

function validateFallbackPrefix(routing: RoutingInput, routeIndex: number, base: string): void {
  for (let index = 0; index < routeIndex; index += 1) {
    const attempt = routing.attempts[index];
    if (
      attempt === undefined ||
      attempt.ref !== routing.route[index].ref ||
      !["failed", "blocked"].includes(attempt.outcome)
    ) {
      throw producerFailure(
        "TRACE_PRODUCER_ATTEMPT_ROUTE_MISMATCH",
        `${base}/attempts/${index}`,
        "fallback requires each preceding authored route step to fail or be blocked",
      );
    }
  }
  if (routing.attempts[routeIndex].ref !== routing.route[routeIndex].ref) {
    throw producerFailure(
      "TRACE_PRODUCER_ATTEMPT_ROUTE_MISMATCH",
      `${base}/attempts/${routeIndex}/ref`,
      "filled fallback attempt does not reference its authored route step",
    );
  }
}

function produceBoundary(boundary: BoundaryInput): unknown {
  return {
    id: boundary.id,
    event: "boundary",
    tool: boundary.tool,
    outcome: boundary.outcome,
    sent: boundary.sent,
    ...(boundary.received === undefined ? {} : { received: boundary.received }),
    ...(boundary.reason === undefined ? {} : { reason: boundary.reason }),
    fill: boundary.fill,
    ...(boundary.internal === undefined ? {} : { internal: boundary.internal }),
    measured: boundary.measured,
  };
}

function producerFailure(code: string, pointer: string, message: string): TraceProducerFailure {
  return new TraceProducerFailure({ code, pointer, message });
}
