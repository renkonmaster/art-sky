import { ApiError } from "../api/client.ts";

export function Loading({ label = "読み込み中" }: { label?: string }) {
  return (
    <p className="state" role="status">
      {label}…
    </p>
  );
}

export function ErrorNote({ error, notFound }: { error: Error; notFound?: string }) {
  const missing = error instanceof ApiError && error.status === 404;
  return (
    <p className="state state-error" role="alert">
      {missing && notFound ? notFound : `読み込めませんでした：${error.message}`}
    </p>
  );
}
