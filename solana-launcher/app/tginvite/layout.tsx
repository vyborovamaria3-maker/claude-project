import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "TGInvite - POTAPoff",
  description: "Smart member import from Telegram channels",
};

export default function TGInviteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
