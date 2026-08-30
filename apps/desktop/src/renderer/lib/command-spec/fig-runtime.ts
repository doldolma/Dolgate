// Fig 제너레이터 런타임은 shared-core 에 있다 — 모바일도 같은 코드로 같은 결과를 내야 한다.
export {
  figSuggestionName,
  figSuggestionsToCompletions,
  findArgGenerators,
  runGenerators,
  type FigExecuteCommand,
  type FigExecuteCommandInput,
  type FigGenerator,
  type FigGeneratorContext,
  type FigSpecNode,
  type FigSuggestion,
} from "@shared";
