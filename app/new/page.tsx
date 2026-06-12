import { NewInvestigation } from "./investigation-client";

export default async function NewPage({
  searchParams,
}: {
  searchParams: Promise<{ ticker?: string }>;
}) {
  const { ticker } = await searchParams;
  return <NewInvestigation initialTicker={ticker?.toUpperCase() ?? ""} />;
}
