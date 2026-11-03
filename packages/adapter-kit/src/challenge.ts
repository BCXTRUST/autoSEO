/** Provider-neutral CAPTCHA task primitives for explicitly authorized workflows. */

export interface ImageToTextChallengeInput {
  type: "image-to-text";
  /** Caller attests that this solve is part of an authorized workflow. */
  authorizedUse: true;
  /** Base64-encoded image bytes, without a data URL prefix. */
  imageBase64: string;
  phrase?: boolean;
  caseSensitive?: boolean;
  /** Anti-Captcha character filter: 0 any, 1 digits, 2 letters, 3 letters and digits. */
  numeric?: 0 | 1 | 2 | 3;
  minLength?: number;
  maxLength?: number;
}

export type ChallengeTaskResult =
  | { status: "processing" }
  | { status: "ready"; solution: { text: string }; costUsd?: number }
  | { status: "failed"; code: string };

export interface ChallengeOperationOptions {
  signal?: AbortSignal;
}

export interface ChallengeProvider {
  getBalance(options?: ChallengeOperationOptions): Promise<{ balanceUsd: number }>;
  createTask(
    input: ImageToTextChallengeInput,
    options?: ChallengeOperationOptions,
  ): Promise<{ taskId: string; estimatedCostUsd?: number }>;
  pollTask(taskId: string, options?: ChallengeOperationOptions): Promise<ChallengeTaskResult>;
}
