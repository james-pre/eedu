---
name: zybooks-lab
description: Work through a zyBooks lab. Covers IT labs, carried out on Windows and Linux VMs and graded by checks run on them, and programming labs, where code is written and run against the lab's test cases. Use for lab activities rather than questions that are answered.
---

# zyBooks labs

A lab is graded by a machine, not by reading your work, so a lab is only done when the thing being checked is actually true: the VM is in the state a goal describes, or the program produces the output a test expects. Decide which kind of lab this is from the tools you have. `use_vm` and `screenshot` mean an IT lab; `run_tests` means a programming lab.

Both kinds end the same way: say plainly what passed, what didn't, and why, and keep a short `notes.md` in your directory as you go. The student reviews the lab afterwards, and that file is what they read.

## IT labs

The lab runs on VMs you drive through their screens, the way the student would. There is no shell on them apart from the one on screen.

- `use_vm` switches VMs. Each step says which VM it is for, and a goal is checked on one specific VM.
- Take a `screenshot` before acting on a new screen and after anything that should change it. Act only on what the screenshot shows, never on what you expect to be there.
- `click` coordinates come from the screenshot you just took. Nothing else tells you where a window is.
- `type_text` types into whatever has focus, so click the window first. End a command with `\n` or press Enter with `press_keys`.
- The VMs have finished starting before you begin, and the screen tools reconnect on their own if a screen stops updating. Applications are still slow to open, so `wait` and take another screenshot rather than typing into a window that isn't ready.

When a VM stops responding, first make sure it isn't just slow: `wait`, then take another screenshot. If the screen still doesn't change after input, call `reconnect_vm`, which opens a new connection without touching the VM. Only if that doesn't help, call `restart_vms`. It replaces all of the lab's VMs with fresh ones and takes a few minutes. Points already earned are kept, but everything done on the VMs is gone, so redo the steps for every goal that hasn't passed, including setup that later goals depend on.

A terminal is more reliable than clicking through a GUI. When a step's result can be reached from PowerShell on Windows or the Terminal Emulator on Kali, use it: fewer screenshots, and the state is easier to verify. If one VM is unusable and the lab has set up SSH between them, reaching it from the other VM's terminal is fair game.

### Following the steps

Work the steps in order. They build on each other, and later steps assume the earlier ones ran.

- Steps that only explain something still matter, because they name the paths, filenames, and passwords later steps need. Lab credentials are given in the instructions.
- Filenames and paths must match the lab exactly. A goal checking for `training_lab` does not accept `training_lab.txt` if that is not what it asked for.
- Some steps are there to be read, not done ("the taskbar works like this"). Move on.
- A goal already earned does not mean the VM is in that state. These VMs are fresh, so if a later step needs what an earned goal created, make it again.

### Checking completion

Call `check_completion` once the steps for a goal are done, the same as clicking Check completion. Don't save them all for the end: checking as you go confirms the VM is in the right state while you are still on that part of the lab.

When a goal comes back incomplete, read the command it is checked with, take a screenshot, and work out which part of the state doesn't match. Fix the VM and check again. Don't check the same goal repeatedly without changing anything.

If a goal's check needs a VM that is still starting, wait and check it again.

The VMs are started before you begin and deleted once you are done, so ignore steps telling you to connect to or delete VMs.

## Programming labs

You write the program in your working directory and `run_tests` builds it and runs it against the lab's own test cases, the same ones zyBooks grades with.

- Write the whole program to the file named in the prompt before running anything. Read the instructions for the exact output wording, spacing, and punctuation; most failures are formatting, not logic.
- Run the tests as soon as something is worth running, then after each change. A test that fails reports the first line that differs, which usually points straight at the problem.
- Match the expected output exactly, including capitalization, spaces, and whether there is a trailing newline. A test that says the output must start with the expected text still has to match that text exactly as far as it goes.
- A test that reads input gets it on standard input. Prompt text counts as output, so print prompts exactly as the lab shows them, and don't add prompts it doesn't ask for.
- A test that times out is usually a program waiting for input that isn't coming, or a loop that doesn't end.
- Hidden tests show neither input nor expected output. Write the general case the instructions describe rather than special-casing the visible tests, which is the point of hiding them.

Solve the problem the lab sets. Printing the expected output directly passes the visible tests and fails the hidden ones, and teaches the student nothing.

### Submitting

Your working directory already holds the lab's files as they are in the student's zyStudio editor, so start from the code that is there rather than from a blank file.

`run_tests` only runs on this machine. Points come from `submit_lab`, which uploads your files to zyStudio, runs the tests there, and records the result. Run the tests locally until they pass before submitting: a submission counts, and some labs limit how many you get. The student approves each submission, and that prompt is how you ask, so there is no need to ask separately first.

Report the score `submit_lab` comes back with. If it is lower than your local run, the difference is a hidden test or an output detail, so read what failed and fix it rather than submitting again unchanged.
