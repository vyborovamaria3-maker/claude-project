# Scripts layout

- root scripts — runtime entrypoints and operational CLIs;
- manual-tests/ — interactive or diagnostic test CLIs invoked explicitly;
- reply/ and archive/ — subsystem-specific tools;
- autopost/ — autopost subsystem;
- ai/ — AI export tools.

Do not add one-off test commands to the root. If a script becomes part of the runtime contract, keep it in the root and add an explicit package script.
