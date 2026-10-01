/**
 * Policy contract (invariant 3): every filesystem mutation and every shell or
 * network action must be classified as an `Action` and decided by a
 * `PolicyGate` before it happens.
 *
 * The interface lives here in M0; the sandbox and approval implementations land
 * in M5.
 */

export type SandboxMode = 'read-only' | 'workspace-write' | 'full-access';

export type Action =
  | { readonly kind: 'fs.read'; readonly path: string }
  | { readonly kind: 'fs.write'; readonly path: string }
  | { readonly kind: 'shell.exec'; readonly command: string; readonly cwd: string }
  | { readonly kind: 'net.fetch'; readonly url: string };

export type PolicyOutcome = 'allow' | 'deny' | 'ask';

export interface PolicyDecision {
  readonly outcome: PolicyOutcome;
  readonly reason?: string;
}

export interface PolicyGate {
  readonly mode: SandboxMode;
  decide(action: Action): Promise<PolicyDecision>;
}
