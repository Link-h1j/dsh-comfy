/**
 * Host entry for the dsh-comfy plugin.
 *
 * The host half owns the /api/dsh-comfy route family: ComfyUI discovery,
 * workflow reading/conversion, run submission and output proxying. The browser
 * half (./client) renders the right-sidebar workflow canvas and talks to that
 * family over same-origin fetch.
 */
import { makeRoutes } from './lib/routes.js'

/** Only the raw HTTP server is required; ComfyUI itself is reached by fetch. */
export const inject = ['webServer']

/**
 * Mount the route family for this plugin's lifetime.
 * @param ctx - host context carrying the web server service.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposers = makeRoutes(ctx).map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'dsh-comfy: /api/dsh-comfy routes')
}
