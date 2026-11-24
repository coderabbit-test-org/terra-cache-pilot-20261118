import type { DispatchPlan, WorkItem } from "./dispatch-planner.js";

export interface Lease {
  item: WorkItem;
  token: string;
  generation: number;
  expiresAt: number;
}

export type Delivery =
  | { state: "accepted"; receipt: string }
  | { state: "rejected"; retryAt?: number }
  | { state: "unknown"; requestId: string };

export interface Repository {
  revision(): Promise<number>;
  claim(input: {
    itemId: string;
    expectedRevision: number;
    owner: string;
    expiresAt: number;
  }): Promise<Lease | undefined>;
  current(itemId: string): Promise<Lease | undefined>;
  acknowledge(lease: Lease, receipt: string): Promise<boolean>;
  defer(lease: Lease, retryAt: number, reason: string): Promise<boolean>;
  release(lease: Lease, reason: string): Promise<boolean>;
  noteUnknown(lease: Lease, requestId: string): Promise<void>;
  extend(lease: Lease, expiresAt: number): Promise<Lease | undefined>;
}

export interface DispatchResult {
  accepted: Map<string, string>;
  deferred: Map<string, string>;
  uncertain: Map<string, string>;
  lost: Set<string>;
  stopped: boolean;
}

export async function executePlan(
  plan: DispatchPlan,
  options: {
    owner: string;
    leaseMs: number;
    renewBeforeMs: number;
    deadline: number;
    maxUnknown: number;
    clock: () => number;
    signal: AbortSignal;
    repository: Repository;
    send: (item: WorkItem, token: string, signal: AbortSignal) => Promise<Delivery>;
    reconcile: (requestId: string, signal: AbortSignal) => Promise<Delivery>;
  },
): Promise<DispatchResult> {
  if (!options.owner || !Number.isSafeInteger(options.leaseMs) ||
      options.leaseMs < 1 || options.renewBeforeMs < 0 ||
      options.renewBeforeMs >= options.leaseMs) {
    throw new Error("Invalid lease options");
  }
  if (!Number.isSafeInteger(options.deadline) ||
      !Number.isSafeInteger(options.maxUnknown) || options.maxUnknown < 1) {
    throw new Error("Invalid execution limits");
  }
  const result: DispatchResult = {
    accepted: new Map(),
    deferred: new Map(plan.deferred),
    uncertain: new Map(),
    lost: new Set(),
    stopped: false,
  };
  const { repository } = options;
  if (await repository.revision() !== plan.snapshotRevision) {
    for (const item of plan.selected) result.deferred.set(item.id, "snapshot_changed");
    return result;
  }

  for (const item of plan.selected) {
    if (options.signal.aborted || options.clock() >= options.deadline) {
      result.stopped = true;
      result.deferred.set(item.id, "execution_stopped");
      continue;
    }
    if (result.uncertain.size >= options.maxUnknown) {
      result.stopped = true;
      result.deferred.set(item.id, "uncertainty_limit");
      continue;
    }
    const now = options.clock();
    if (item.deadline !== undefined && item.deadline <= now) {
      result.deferred.set(item.id, "item_deadline");
      continue;
    }
    let lease = await repository.claim({
      itemId: item.id,
      expectedRevision: item.revision,
      owner: options.owner,
      expiresAt: Math.min(now + options.leaseMs, options.deadline),
    });
    if (!lease) {
      result.lost.add(item.id);
      continue;
    }
    if (lease.item.tenant !== item.tenant || lease.item.id !== item.id ||
        lease.generation < item.revision || !lease.token) {
      result.lost.add(item.id);
      result.stopped = true;
      break;
    }
    if (options.signal.aborted) {
      const released = await repository.release(lease, "cancelled_before_send");
      if (!released) result.lost.add(item.id);
      result.stopped = true;
      continue;
    }
    if (lease.expiresAt - options.clock() <= options.renewBeforeMs) {
      const renewed = await repository.extend(
        lease,
        Math.min(options.clock() + options.leaseMs, options.deadline),
      );
      if (!renewed || renewed.token !== lease.token ||
          renewed.generation !== lease.generation) {
        result.lost.add(item.id);
        continue;
      }
      lease = renewed;
    }
    if (lease.expiresAt <= options.clock()) {
      result.lost.add(item.id);
      continue;
    }

    let delivery: Delivery;
    try {
      delivery = await options.send(item, lease.token, options.signal);
    } catch {
      const requestId = `${item.id}:${lease.generation}`;
      await repository.noteUnknown(lease, requestId);
      result.uncertain.set(item.id, requestId);
      continue;
    }
    if (delivery.state === "unknown") {
      await repository.noteUnknown(lease, delivery.requestId);
      result.uncertain.set(item.id, delivery.requestId);
      if (options.signal.aborted || options.clock() >= options.deadline) continue;
      const current = await repository.current(item.id);
      if (!current || current.token !== lease.token ||
          current.generation !== lease.generation) {
        result.lost.add(item.id);
        continue;
      }
      try {
        const observed = await options.reconcile(delivery.requestId, options.signal);
        if (observed.state === "unknown") continue;
        delivery = observed;
      } catch {
        continue;
      }
    }

    const current = await repository.current(item.id);
    if (!current || current.token !== lease.token ||
        current.generation !== lease.generation || current.expiresAt <= options.clock()) {
      result.lost.add(item.id);
      continue;
    }
    if (delivery.state === "accepted") {
      if (!delivery.receipt) {
        result.uncertain.set(item.id, `${item.id}:${lease.generation}`);
        continue;
      }
      const saved = await repository.acknowledge(current, delivery.receipt);
      if (saved) {
        result.accepted.set(item.id, delivery.receipt);
        result.uncertain.delete(item.id);
      } else {
        result.lost.add(item.id);
        result.uncertain.set(item.id, delivery.receipt);
      }
      continue;
    }
    if (delivery.state === "rejected") {
      const retryAt = delivery.retryAt ?? options.clock() + options.leaseMs;
      if (!Number.isSafeInteger(retryAt) || retryAt < options.clock()) {
        result.uncertain.set(item.id, "invalid_retry_time");
        continue;
      }
      if (item.deadline !== undefined && retryAt >= item.deadline) {
        const released = await repository.release(current, "retry_after_deadline");
        if (!released) result.lost.add(item.id);
        else result.deferred.set(item.id, "retry_after_deadline");
        result.uncertain.delete(item.id);
        continue;
      }
      const saved = await repository.defer(current, retryAt, "delivery_rejected");
      if (!saved) {
        result.lost.add(item.id);
      } else {
        result.deferred.set(item.id, "retry_scheduled");
        result.uncertain.delete(item.id);
      }
    }
  }
  return result;
}
