# Shared workspace UI

`@kasitek-labs/ui` owns the common light and charcoal dark theme, appearance definitions and generic React controls used by Growth and Agents. Product navigation, data loading, sessions and business permissions stay in each product.

```tsx
import { Button } from "@kasitek-labs/ui/button";
import { Dialog, DialogContent } from "@kasitek-labs/ui/dialog";
import { ACCENTS, WORKSPACE_PALETTE } from "@kasitek-labs/ui/appearance";
```

Import the theme after Tailwind in the consumer stylesheet:

```css
@import "tailwindcss";
@import "@kasitek-labs/ui/theme.css";
```

The theme explicitly registers this package's source with Tailwind. Consumers also register `packages/ui/src` relative to their stylesheet, so scanning works in workspace and Docker builds. Keep the package source in the frontend build context. The shared CSS does not load Tailwind or product layout styles itself.

Run `pnpm --filter @kasitek-labs/ui build` before a consumer build or typecheck. Growth's dev, build and typecheck commands chain this build explicitly. They do not rely on pnpm's optional pre/post script hooks. Root `build:shared` includes this package. JavaScript and declaration exports live in ignored `dist/`; do not commit build output. Rebuild the package after changing a React control or appearance definitions during development.

Controls retain existing props, `asChild`, refs and `data-slot` hooks. Product-local UI modules may re-export these public modules so existing imports keep working. Do not copy shared implementations back into a product or import another product's private UI source.

Theme mode, density and accent definitions are shared. Storage remains browser-origin local; using the same keys does not synchronize preferences across separate production domains. Products retain their own preference lifecycle. A valid saved accent remains explicit; an unset Growth preference uses blue. Agents may normalize its former implicit Indigo default because it has no accent picker. Neither policy changes product authorization.

Shared styles use Geist through each application's existing font loading. Keep provider logos separate from UI line icons. Public landing pages and embedded website widgets retain their own scoped visual treatment.

For rollback, revert the package and consumer imports together and rebuild each affected frontend artifact. There is no API or database migration. The package is private and is bundled into independently deployed clients.
