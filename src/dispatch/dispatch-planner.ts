export interface WorkItem {
  id: string;
  tenant: string;
  lane: string;
  state: "waiting" | "leased" | "running" | "complete" | "cancelled";
  revision: number;
  createdAt: number;
  notBefore: number;
  deadline?: number;
  leaseUntil?: number;
  attempts: number;
  maxAttempts: number;
  cost: number;
  bytes: number;
  priority: number;
  idempotencyKey: string;
  dependencies: readonly string[];
}

export interface Lane {
  name: string;
  tenant: string;
  enabled: boolean;
  weight: number;
  running: number;
  maxRunning: number;
  availableCost: number;
  availableBytes: number;
  deficit: number;
  lastServedAt: number;
}

export interface DispatchSnapshot {
  revision: number;
  items: readonly WorkItem[];
  lanes: readonly Lane[];
  completedIds: ReadonlySet<string>;
  cancelledTenants: ReadonlySet<string>;
  committedKeys: ReadonlyMap<string, string>;
}

export interface DispatchPlan {
  snapshotRevision: number;
  selected: WorkItem[];
  deferred: Map<string, string>;
  rejected: Map<string, string>;
  nextWakeAt?: number;
  nextLanes: Lane[];
}

export function planDispatch(
  snapshot: DispatchSnapshot,
  now: number,
  limits: {
    maxItems: number;
    maxCost: number;
    maxBytes: number;
    leaseMs: number;
    retryBaseMs: number;
    retryMaxMs: number;
  },
): DispatchPlan {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid clock");
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Limits must be positive safe integers");
    }
  }
  if (limits.retryBaseMs > limits.retryMaxMs) {
    throw new Error("Retry base exceeds maximum");
  }

  const lanes = new Map<string, Lane>();
  const keyFor = (tenant: string, lane: string) => JSON.stringify([tenant, lane]);
  for (const source of snapshot.lanes) {
    const key = keyFor(source.tenant, source.name);
    if (lanes.has(key)) throw new Error("Duplicate lane");
    if (!source.tenant || !source.name) throw new Error("Missing lane identity");
    if (!Number.isSafeInteger(source.weight) || source.weight < 1) {
      throw new Error("Invalid lane weight");
    }
    if (source.running < 0 || source.running > source.maxRunning) {
      throw new Error("Invalid running count");
    }
    lanes.set(key, { ...source });
  }

  const plan: DispatchPlan = {
    snapshotRevision: snapshot.revision,
    selected: [],
    deferred: new Map(),
    rejected: new Map(),
    nextLanes: [],
  };
  const observedIds = new Set<string>();
  const observedKeys = new Set<string>();
  const waiting = new Map<string, WorkItem[]>();
  let remainingCost = limits.maxCost;
  let remainingBytes = limits.maxBytes;

  const wakeAt = (timestamp: number) => {
    if (timestamp > now && Number.isSafeInteger(timestamp)) {
      plan.nextWakeAt = Math.min(plan.nextWakeAt ?? timestamp, timestamp);
    }
  };

  for (const item of snapshot.items) {
    if (observedIds.has(item.id)) throw new Error("Duplicate work identity");
    observedIds.add(item.id);
    if (item.state === "complete" || item.state === "cancelled") continue;
    const key = keyFor(item.tenant, item.lane);
    const lane = lanes.get(key);
    if (!lane || !lane.enabled) {
      plan.deferred.set(item.id, "lane_unavailable");
      continue;
    }
    if (snapshot.cancelledTenants.has(item.tenant)) {
      plan.rejected.set(item.id, "tenant_cancelled");
      continue;
    }
    if (!item.id || !item.idempotencyKey || item.revision < 0) {
      plan.rejected.set(item.id, "invalid_identity");
      continue;
    }
    if (!Number.isSafeInteger(item.cost) || item.cost < 1 ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 0) {
      plan.rejected.set(item.id, "invalid_resources");
      continue;
    }
    if (item.cost > limits.maxCost || item.bytes > limits.maxBytes ||
        item.cost > lane.availableCost || item.bytes > lane.availableBytes) {
      plan.deferred.set(item.id, "insufficient_capacity");
      continue;
    }
    if (item.deadline !== undefined && item.deadline <= now) {
      plan.rejected.set(item.id, "deadline_expired");
      continue;
    }
    if (item.attempts >= item.maxAttempts) {
      plan.rejected.set(item.id, "attempts_exhausted");
      continue;
    }
    if (item.state === "leased" || item.state === "running") {
      if (item.leaseUntil === undefined) {
        plan.rejected.set(item.id, "missing_lease");
        continue;
      }
      if (item.leaseUntil > now) {
        plan.deferred.set(item.id, "lease_active");
        wakeAt(item.leaseUntil);
        continue;
      }
    }
    const delay = item.attempts === 0 ? 0 : Math.min(
      limits.retryMaxMs,
      limits.retryBaseMs * 2 ** Math.min(item.attempts - 1, 30),
    );
    const eligibleAt = Math.max(item.notBefore, item.createdAt + delay);
    if (eligibleAt > now) {
      plan.deferred.set(item.id, "scheduled_later");
      wakeAt(eligibleAt);
      continue;
    }
    if (item.deadline !== undefined && now + limits.leaseMs > item.deadline) {
      plan.rejected.set(item.id, "insufficient_deadline");
      continue;
    }
    if (item.dependencies.some(id => !snapshot.completedIds.has(id))) {
      plan.deferred.set(item.id, "dependency_pending");
      continue;
    }
    const idempotencyKey = JSON.stringify([item.tenant, item.idempotencyKey]);
    const committed = snapshot.committedKeys.get(idempotencyKey);
    if (committed !== undefined && committed !== item.id) {
      plan.rejected.set(item.id, "already_committed");
      continue;
    }
    if (observedKeys.has(idempotencyKey)) {
      plan.deferred.set(item.id, "duplicate_pending");
      continue;
    }
    observedKeys.add(idempotencyKey);
    const list = waiting.get(key) ?? [];
    list.push({ ...item, dependencies: [...item.dependencies] });
    waiting.set(key, list);
  }

  for (const list of waiting.values()) {
    list.sort((a, b) => b.priority - a.priority ||
      a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  const laneOrder = [...lanes.entries()].sort((a, b) =>
    a[1].lastServedAt - b[1].lastServedAt || a[0].localeCompare(b[0]));
  let madeProgress = true;
  while (madeProgress && plan.selected.length < limits.maxItems) {
    madeProgress = false;
    for (const [key, lane] of laneOrder) {
      const queue = waiting.get(key);
      if (!queue?.length || lane.running >= lane.maxRunning) continue;
      lane.deficit = Math.min(limits.maxCost, lane.deficit + lane.weight);
      let selectedIndex = -1;
      for (let index = 0; index < queue.length; index += 1) {
        const item = queue[index];
        if (item.cost > lane.deficit) continue;
        if (item.cost > remainingCost || item.bytes > remainingBytes) continue;
        if (item.cost > lane.availableCost || item.bytes > lane.availableBytes) continue;
        selectedIndex = index;
        break;
      }
      if (selectedIndex < 0) continue;
      const [item] = queue.splice(selectedIndex, 1);
      lane.deficit -= item.cost;
      lane.running += 1;
      lane.availableCost -= item.cost;
      lane.availableBytes -= item.bytes;
      lane.lastServedAt = now;
      remainingCost -= item.cost;
      remainingBytes -= item.bytes;
      plan.selected.push(item);
      madeProgress = true;
      if (plan.selected.length >= limits.maxItems) break;
    }
  }
  for (const [key, queue] of waiting) {
    const lane = lanes.get(key)!;
    for (const item of queue) {
      const reason = lane.running >= lane.maxRunning ? "lane_concurrency" :
        item.cost > remainingCost || item.bytes > remainingBytes ?
          "global_capacity" : "fairness_deficit";
      plan.deferred.set(item.id, reason);
    }
  }
  plan.nextLanes = [...lanes.values()];
  return plan;
}
