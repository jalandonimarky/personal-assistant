import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Personal Assistant",
  description: "Isolated contexts, reviewed answers",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
