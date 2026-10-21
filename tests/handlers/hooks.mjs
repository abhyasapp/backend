export async function resolve(spec, ctx, next) {
  if (spec.startsWith('https://esm.sh/@supabase')) return { url: new URL('./mock-supabase.mjs', import.meta.url).href, shortCircuit: true };
  return next(spec, ctx);
}
