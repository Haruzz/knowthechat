import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://knowthechat.com"),
  title: "Who Said It?",
  description: "A Twitch chat guessing game built from the people you actually know.",
  alternates: { canonical: "/" },
  icons: { icon: "/logo.png", apple: "/logo.png" },
  openGraph: { title: "Who Said It?", description: "Know your chat. Skip the strangers.", url: "/", siteName: "Know The Chat", images: ["/og.png"] },
  twitter: { card: "summary_large_image", title: "Who Said It?", description: "Know your chat. Skip the strangers.", images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
