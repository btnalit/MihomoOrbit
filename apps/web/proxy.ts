import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

// Next.js 16 uses 'proxy' instead of deprecated 'middleware' convention
// https://nextjs.org/docs/messages/middleware-to-proxy
export default createMiddleware(routing);

export const config = {
  matcher: ["/((?!api|_next|static|.*\\..*).*)"],
};
