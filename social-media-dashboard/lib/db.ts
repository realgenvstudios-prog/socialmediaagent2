import postgres from "postgres"

const sql = postgres(process.env.DATABASE_URL!, {
  ssl: "require",
  max: 5,
  idle_timeout: 20,
  transform: {
    value(v: unknown) {
      // Return all Date objects as ISO strings so pages can do .slice(), >= comparisons, etc.
      if (v instanceof Date) return v.toISOString()
      return v
    },
  },
})

export default sql
