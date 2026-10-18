import type { DependencyServiceStatus } from "./action-types";

type DependencyControlPolicyInput = {
  manageable: boolean;
  identityAvailable: boolean;
  sameManagedProfile: boolean;
  states: DependencyServiceStatus["state"][];
};

export function dependencyControlPolicy(input: DependencyControlPolicyInput) {
  const allStopped = input.states.length > 0 && input.states.every((state) => state === "stopped");
  return {
    ownedByDevHub: input.sameManagedProfile,
    canStart: input.manageable && input.identityAvailable && allStopped && !input.sameManagedProfile,
    canStop: input.manageable && input.sameManagedProfile,
  };
}
