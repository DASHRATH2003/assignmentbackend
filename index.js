require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// MongoDB Connection
// In-memory storage fallback
let users = [];
let images = [];
let mongoConnected = false;

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => {
    console.log('MongoDB connected');
    mongoConnected = true;
    initializeUsers();
  })
  .catch(err => {
    console.log('MongoDB connection error:', err);
    console.log('Using in-memory storage as fallback');
    initializeInMemoryUsers();
  });

// Multer Configuration for file uploads
const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function(req, file, cb) {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: function(req, file, cb) {
    const filetypes = /jpeg|jpg|png|gif/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only image files are allowed!'));
  }
});

// Create uploads directory if it doesn't exist
const fs = require('fs');
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}

// MongoDB Schemas
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  isAdmin: { type: Boolean, default: false }
}, { timestamps: true });

const imageSchema = new mongoose.Schema({
  title: { type: String, required: true },
  url: { type: String, required: true },
  cloudinaryId: { type: String, required: true }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Image = mongoose.model('Image', imageSchema);

// Initialize default users if they don't exist
const initializeUsers = async () => {
  try {
    const adminExists = await User.findOne({ email: 'admin@gmail.com' });
    if (!adminExists) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await User.create({
        email: 'admin@gmail.com',
        password: hashedPassword,
        isAdmin: true
      });
      console.log('Admin user created');
    }
  } catch (error) {
    console.error('Error initializing users:', error);
  }
};

const initializeInMemoryUsers = async () => {
  try {
    const hashedAdminPassword = await bcrypt.hash('admin123', 10);
    const hashedUserPassword = await bcrypt.hash('password123', 10);
    
    users = [
      {
        id: 1,
        email: 'admin@gmail.com',
        password: hashedAdminPassword,
        isAdmin: true
      },
      {
        id: 2,
        email: 'user@gmail.com',
        password: hashedUserPassword,
        isAdmin: false
      }
    ];
    console.log('In-memory users initialized');
  } catch (error) {
    console.error('Error initializing in-memory users:', error);
  }
};

// Call initialization after MongoDB connection
mongoose.connection.once('open', () => {
  initializeUsers();
});

// Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ message: 'Access denied' });
  
  jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret', (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Admin Middleware
const isAdmin = (req, res, next) => {
  if (!req.user.isAdmin) return res.status(403).json({ message: 'Admin access required' });
  next();
};

// Routes

// User Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    let user;
    
    if (mongoConnected) {
      user = await User.findOne({ email });
    } else {
      user = users.find(u => u.email === email);
    }
    
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { userId: mongoConnected ? user._id : user.id, email: user.email, isAdmin: user.isAdmin },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({ token, isAdmin: user.isAdmin });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all images
app.get('/api/images', async (req, res) => {
  try {
    if (mongoConnected) {
      const dbImages = await Image.find().sort({ createdAt: -1 });
      res.json(dbImages);
    } else {
      res.json(images.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    }
  } catch (error) {
    console.error('Error fetching images:', error);
    res.status(500).json({ message: 'Error fetching images', error: error.message });
  }
});

// Upload image (admin only)
app.post('/api/images/upload', authenticateToken, isAdmin, upload.single('file'), async (req, res) => {
  try {
    const { title } = req.body;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    
    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(file.path, {
      folder: 'image-gallery'
    });
    
    // Delete local file
    fs.unlinkSync(file.path);
    
    if (mongoConnected) {
      // Save to MongoDB
      const newImage = new Image({
        title: title || 'Untitled',
        url: result.secure_url,
        cloudinaryId: result.public_id
      });
      
      await newImage.save();
      res.json(newImage);
    } else {
      // Save to in-memory storage
      const newImage = {
        _id: Date.now().toString(),
        title: title || 'Untitled',
        url: result.secure_url,
        cloudinaryId: result.public_id,
        createdAt: new Date().toISOString()
      };
      
      images.push(newImage);
      res.json(newImage);
    }
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ message: 'Error uploading image', error: error.message });
  }
});

// Update image (admin only)
app.put('/api/images/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title } = req.body;
    
    if (mongoConnected) {
      const updatedImage = await Image.findByIdAndUpdate(
        id,
        { title },
        { new: true }
      );
      
      if (!updatedImage) return res.status(404).json({ message: 'Image not found' });
      res.json(updatedImage);
    } else {
      const imageIndex = images.findIndex(img => img._id === id);
      if (imageIndex === -1) return res.status(404).json({ message: 'Image not found' });
      
      images[imageIndex].title = title;
      res.json(images[imageIndex]);
    }
  } catch (error) {
    console.error('Error updating image:', error);
    res.status(500).json({ message: 'Error updating image', error: error.message });
  }
});

// Delete image (admin only)
app.delete('/api/images/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    let image;
    
    if (mongoConnected) {
      image = await Image.findById(id);
      if (!image) return res.status(404).json({ message: 'Image not found' });
      
      // Delete from Cloudinary
      if (image.cloudinaryId) {
        await cloudinary.uploader.destroy(image.cloudinaryId);
      }
      
      // Remove from MongoDB
      await Image.findByIdAndDelete(id);
    } else {
      const imageIndex = images.findIndex(img => img._id === id);
      if (imageIndex === -1) return res.status(404).json({ message: 'Image not found' });
      
      image = images[imageIndex];
      
      // Delete from Cloudinary
      if (image.cloudinaryId) {
        await cloudinary.uploader.destroy(image.cloudinaryId);
      }
      
      // Remove from in-memory storage
      images.splice(imageIndex, 1);
    }
    
    res.json({ message: 'Image deleted successfully' });
  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({ message: 'Error deleting image', error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});