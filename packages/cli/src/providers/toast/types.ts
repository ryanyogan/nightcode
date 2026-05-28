export type ToastVariant = "success" | "error" | "info";

export type ToastOptions = {
  message: string;
  variant?: ToastVariant;
  duration?: number;
};

export const DEFULT_DURATION = 3_000;
