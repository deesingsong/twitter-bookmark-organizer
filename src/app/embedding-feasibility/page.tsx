import { notFound } from "next/navigation";
import FeasibilityHarness from "./page-client";

export const dynamic = "force-dynamic";

export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <FeasibilityHarness />;
}
