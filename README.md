# FlowDesk – Project Management Tool (Task 3)

Trello/Asana-style collaborative tool.

**Features**
- Auth system (register / login, JWT, hashed passwords)
- Group projects with team members (owner adds members by username)
- Project board with 3 columns: To do, In progress, Done (drag & drop task cards)
- Task cards: description, priority, due date, assignee
- Comments inside every task
- Bonus: notifications + real-time updates using WebSockets (`ws`)

**Stack:** HTML/CSS/JavaScript, Express.js, SQLite (built into Node), WebSocket

## Run
Node.js 22.5 or newer is required (tested with Node 22/24).

    npm install
    npm start

Open http://localhost:3000

Database file `flowdesk.db` is created automatically
(tables: users, projects, members, tasks, comments, notifications).

## Test real-time
Register two users in two different browsers (or one normal + one private window).
User A creates a project and adds user B by username. Open the same board in both
windows: moving a task, commenting or assigning shows up instantly on the other side.
