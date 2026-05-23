"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

export default function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname()
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href)
  return (
    <Link
      href={href}
      style={{
        fontSize: "13px",
        fontWeight: 500,
        color: active ? "var(--text)" : "var(--muted)",
        padding: "6px 12px",
        borderRadius: "6px",
        background: active ? "var(--surface)" : "transparent",
        transition: "all 0.15s ease",
        letterSpacing: "-0.01em",
      }}
    >
      {children}
    </Link>
  )
}
