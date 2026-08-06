import type {ConversationRelation} from "./types.js";

export interface ConversationPresentation {
  readonly kind:"history"|"independent"|"follow_up";
  readonly label:string;
  readonly rawQuestion:string;
  readonly resolvedQuestion:string;
  readonly parentQuestion?:string;
  readonly parentAnswerOutline?:string;
  readonly inheritedSubjects:readonly string[];
}

export function conversationPresentation(question:string,conversation?:ConversationRelation):ConversationPresentation{
  if(conversation===undefined)return{kind:"history",label:"历史记录",rawQuestion:question,resolvedQuestion:question,inheritedSubjects:[]};
  const current=conversation.current;
  if(current.contextUsed)return{kind:"follow_up",label:"上下文追问",rawQuestion:current.rawQuestion,resolvedQuestion:current.resolvedQuestion,...(conversation.parent===undefined?{}:{parentQuestion:conversation.parent.resolvedQuestion,...(conversation.parent.answerOutline===undefined?{}:{parentAnswerOutline:conversation.parent.answerOutline})}),inheritedSubjects:current.inheritedSubjects};
  return{kind:"independent",label:"独立问题",rawQuestion:current.rawQuestion,resolvedQuestion:current.resolvedQuestion,inheritedSubjects:current.inheritedSubjects};
}
