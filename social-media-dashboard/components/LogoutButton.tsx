"use client"

import { useRouter } from "next/navigation"

export default function LogoutButton() {
  const router = useRouter()

  async function handleLogout() {
    await fetch("/api/auth", { method: "DELETE" })
    router.push("/login")
  }

  return (
    <button
      onClick={handleLogout}
      style={{
        fontSize: "12px",
        color: "var(--faint)",
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: "6px 10px",
        marginLeft: "8px",
      }}
    >
      Sign out
    </button>
  )
}
