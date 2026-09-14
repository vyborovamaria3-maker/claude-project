import KolsTwitterPanel from "@/components/trade/KolsTwitterPanel";

export default async function KolsTwitterDetailPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  return <KolsTwitterPanel initialQuery={decodeURIComponent(handle)} detailMode />;
}
