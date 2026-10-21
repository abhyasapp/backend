# verify.ps1 - check that no file still contains __PLACEHOLDER__
# Run from project root:  .\scripts\verify.ps1

$files = @(
  "supabase/config.toml", "supabase/functions/api/deno.json",
  "supabase/functions/api/index.ts",
  "supabase/functions/api/handlers/auth.ts",
  "supabase/functions/api/handlers/users.ts",
  "supabase/functions/api/handlers/content.ts",
  "supabase/functions/api/handlers/weekly.ts",
  "supabase/functions/api/handlers/reports.ts",
  "supabase/functions/api/handlers/subjective.ts",
  "supabase/functions/api/handlers/payments.ts",
  "supabase/functions/api/handlers/admin.ts",
  "supabase/functions/api/_shared/auth.ts",
  "supabase/functions/api/_shared/config.ts",
  "supabase/functions/api/_shared/crypto.ts",
  "supabase/functions/api/_shared/db.ts",
  "supabase/functions/api/_shared/http.ts",
  "supabase/functions/api/_shared/rate-limit.ts",
  "supabase/functions/api/_shared/utils.ts",
  "gas/appsscript.json", "gas/.clasp.json.example",
  "gas/code.gs", "gas/report.gs", "gas/setup.gs", "gas/debug.gs",
  "gas/content-index.gs", "gas/private-files.gs", "gas/migrate-files.gs", "gas/sync.gs",
  ".github/workflows/sync-backends.yml",
  "scripts/sync.js",
  "client/js/api-adapter.js",
  "README.md", ".gitignore", ".env.example", "MANIFEST.md"
)

$fail = 0
foreach ($f in $files) {
    if (-not (Test-Path -LiteralPath $f)) {
        Write-Host ("MISSING      " + $f); $fail++; continue
    }
    if (Select-String -LiteralPath $f -Pattern "__PLACEHOLDER__" -Quiet) {
        Write-Host ("PLACEHOLDER  " + $f); $fail++
    } else {
        Write-Host ("ok           " + $f)
    }
}
Write-Host ""
if ($fail -gt 0) {
    Write-Host ("x " + $fail + " / " + $files.Count + " file(s) still need content.")
    exit 1
} else {
    Write-Host ("OK: All " + $files.Count + " files filled.")
}