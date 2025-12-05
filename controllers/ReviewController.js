const Review = require('../models/Review');
const db = require('../db');

const list = (req, res) => {
  const userId = req.session.user.id;
  const selectedProductId = req.query.productId || '';
  const sendView = (reviews, productInfo=null) => {
    res.render('reviews', {
      user: req.session.user,
      reviews: reviews || [],
      selectedProductId,
      productInfo,
      messages: req.flash('success'),
      errors: req.flash('error')
    });
  };

  Review.listByUser(userId, (err, reviews) => {
    if (err) {
      console.error('DB error /reviews list:', err);
      return res.status(500).send('Database error');
    }
    if (selectedProductId) {
      Review.getProductInfo(selectedProductId, (pErr, rows) => {
        if (pErr) {
          console.error('DB error loading product for review:', pErr);
          return sendView(reviews, null);
        }
        sendView(reviews, rows && rows[0] ? rows[0] : null);
      });
    } else {
      sendView(reviews, null);
    }
  });
};

const create = (req, res) => {
  const userId = req.session.user.id;
  const { productId, rating, comment } = req.body;
  const redirectTarget = '/shopping';
  if (!productId || !rating) {
    req.flash('error', 'Product and rating are required');
    return res.redirect(redirectTarget);
  }
  const ratingNum = Number(rating);
  if (ratingNum < 1 || ratingNum > 5) {
    req.flash('error', 'Rating must be between 1 and 5');
    return res.redirect(redirectTarget);
  }
  Review.create({ productId, userId, rating: ratingNum, comment: comment || '' }, (err) => {
    if (err) {
      console.error('DB error /reviews create:', err);
      req.flash('error', 'Could not save review');
    } else {
      req.flash('success', 'Review submitted');
    }
    res.redirect(redirectTarget);
  });
};

module.exports = { list, create };
