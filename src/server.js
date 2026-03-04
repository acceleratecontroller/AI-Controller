const express = require('express');
const path = require('path');
const db = require('./models/database');
const jobRoutes = require('./routes/jobs');
const uploadRoutes = require('./routes/uploads');
const attachmentRoutes = require('./routes/attachments');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes
app.use('/api/jobs', jobRoutes);
app.use('/api/jobs', attachmentRoutes);
app.use('/api/uploads', uploadRoutes);

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});

// Serve legacy task tracker
app.get('/tasks', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Initialize database and start server
db.initialize();

app.listen(PORT, () => {
  console.log(`Job Creation System running at http://localhost:${PORT}`);
  console.log(`Legacy task tracker at http://localhost:${PORT}/tasks`);
});
