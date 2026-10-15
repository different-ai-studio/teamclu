package expo.modules.teamclumarkdown

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TeamcluMarkdownModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TeamcluMarkdown")

    View(TeamcluMarkdownView::class) {
      Prop("markdown") { view: TeamcluMarkdownView, value: String ->
        view.markdown = value
      }
      Prop("config") { view: TeamcluMarkdownView, value: MarkdownConfig ->
        view.config = value
      }
      // Both props usually change together; render once they have landed.
      OnViewDidUpdateProps { view: TeamcluMarkdownView ->
        view.update()
      }
    }
  }
}
