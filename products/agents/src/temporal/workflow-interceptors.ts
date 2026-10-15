import type {
  ActivityInput,
  Headers,
  LocalActivityInput,
  WorkflowInboundCallsInterceptor,
  WorkflowInterceptors,
  WorkflowOutboundCallsInterceptor,
} from "@temporalio/workflow";

const PROPAGATED_KEYS = new Set(["traceparent", "tracestate", "x-correlation-id"]);

function copyPropagationHeaders(headers: Headers): Headers {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => PROPAGATED_KEYS.has(key.toLowerCase())),
  );
}

function withParentHeaders<T extends ActivityInput | LocalActivityInput>(input: T, parentHeaders: Headers): T {
  return { ...input, headers: { ...parentHeaders, ...input.headers } };
}

/** Temporal workflow-isolate interceptor; intentionally contains no Node or OpenTelemetry SDK APIs. */
export function interceptors(): WorkflowInterceptors {
  let parentHeaders: Headers = {};
  const inbound: WorkflowInboundCallsInterceptor = {
    execute: (input, next) => {
      parentHeaders = copyPropagationHeaders(input.headers);
      return next(input);
    },
  };
  const outbound: WorkflowOutboundCallsInterceptor = {
    scheduleActivity: (input, next) => next(withParentHeaders(input, parentHeaders)),
    scheduleLocalActivity: (input, next) => next(withParentHeaders(input, parentHeaders)),
  };
  return { inbound: [inbound], outbound: [outbound] };
}
