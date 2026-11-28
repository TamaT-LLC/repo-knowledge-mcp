import { ConversationStoreError } from "../conversation-key.js";
import { ConversationStore } from "../conversation-store.js";
import type { DoctorReportBuilder } from "./report-builder.js";
import { errorMessage } from "./util.js";

/**
 * Reports the conversation data area without reading utterance text: an
 * unfinished or unrecoverable key reset, an unusable key, or an interrupted
 * purge is a warning with the command that resolves it.
 */
export async function inspectConversationStore(
  report: DoctorReportBuilder,
  storageRoot: string,
): Promise<void> {
  const store = new ConversationStore(storageRoot);
  try {
    const status = await store.status();
    const { warnings } = status;
    report.add({
      id: "conversations.store",
      path: store.directory,
      status: warnings.length === 0 ? "pass" : "warn",
      details: {
        key: status.key.state,
        reset_pending: status.reset_pending !== null,
        warnings: warnings.map((entry) => entry.code),
      },
      // Every warning, each with its own fix.
      message:
        warnings.length > 0
          ? warnings.map((entry) => entry.message).join(" ")
          : status.data_directory.present
            ? "Conversation data area is consistent."
            : "Conversation data area has not been created yet.",
      ...(warnings.length === 0
        ? {}
        : {
            remedy: [...new Set(warnings.map((entry) => entry.remedy))].join(
              "; then ",
            ),
          }),
    });
  } catch (error) {
    report.add({
      id: "conversations.store",
      path: store.directory,
      status: "fail",
      message: errorMessage(error),
      remedy: failureRemedy(error),
    });
  }
}

/**
 * The narrowest fix for each failure. Damaged data files are warnings from
 * status (with their own fixes); what remains here is the directory itself.
 */
function failureRemedy(error: unknown): string {
  return error instanceof ConversationStoreError &&
    error.code === "CONVERSATION_DATA_PATH_UNSAFE"
    ? "Make conversations a real private directory (0700) with regular files, not symbolic links"
    : "Check that the conversations directory and its files are readable and owned by you";
}
