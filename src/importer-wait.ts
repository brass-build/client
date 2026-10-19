// The rejections of opens that stopped waiting for this app's
// `registerImporter`. A follower keeps an input refused this way for the
// registration, where an input another app imports waits for its import.
export const importerWaitRejections = new WeakSet<object>();
