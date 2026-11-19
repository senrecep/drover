// Holds the Simulator panel's screen frames. Herdr reloads a changed image only when it lives in
// another mod's folder, so drover-sim's helper writes its frame ring here. Nothing is drawn.
import { View, div } from "gpui-kit";

export default class extends View {
  render() { return div(); }
}
