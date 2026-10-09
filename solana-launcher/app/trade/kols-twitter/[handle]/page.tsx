import KOLRelatedWalletsPanel from "@/components/trade/KOLRelatedWalletsPanel";
import KolsTwitterPanel from "@/components/trade/KolsTwitterPanel";

export default async function KolsTwitterDetailPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const decodedHandle = decodeURIComponent(handle);
  return (
    <>
      <KolsTwitterPanel initialQuery={decodedHandle} detailMode />
      <KOLRelatedWalletsPanel handle={decodedHandle} />
    </>
  );
}
