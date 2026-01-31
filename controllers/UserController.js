const User = require('../models/User');

const UserController = {
    showRegister: (req, res) => {
        res.render('register', { 
            messages: req.flash('error'), 
            formData: req.flash('formData')[0] 
        });
    },

    register: (req, res) => {
        const { username, email, password, address, countryCode, contactNumber } = req.body;
        const contact = (contactNumber || '').replace(/\D/g, '');

        User.findByUsernameOrEmail(username, email, (err, existingUser) => {
            if (err) {
                console.error('Registration check error:', err);
                req.flash('error', 'Registration failed. Try again.');
                return res.redirect('/register');
            }

            if (existingUser) {
                if (existingUser.username === username) req.flash('error', 'Username exists');
                else req.flash('error', 'Email has been registered');
                req.flash('formData', req.body);
                return res.redirect('/register');
            }

            User.create({ username, email, password, address, contact, role: 'user' }, (createErr) => {
                if (createErr) {
                    console.error('User creation error:', createErr);
                    req.flash('error', 'Registration failed. Try again.');
                    return res.redirect('/register');
                }
                req.flash('success', 'Registration successful! Please log in.');
                res.redirect('/login');
            });
        });
    },

    showLogin: (req, res) => {
        res.render('login', { 
            messages: req.flash('success'), 
            errors: req.flash('error') 
        });
    },

    login: (req, res) => {
        const { email, password } = req.body;
        if (!email || !password) {
            req.flash('error', 'Email and password are required');
            return res.redirect('/login');
        }

        User.findByEmailAndPassword(email, password, (err, user) => {
            if (err) {
                console.error('Login error:', err);
                req.flash('error', 'Login failed. Try again later.');
                return res.redirect('/login');
            }

            if (user) {
                if ((user.role || '').toLowerCase() === 'deleted') {
                    req.flash('error', 'This account has been deleted.');
                    return res.redirect('/login');
                }
                req.session.user = user;
                
                req.flash('success', 'Login successful!');
                return res.redirect(user.role === 'admin' ? '/inventory' : '/shopping');
            } else {
                req.flash('error', 'Invalid email or password.');
                return res.redirect('/login');
            }
        });
    },

    logout: (req, res) => {
        req.session.destroy(() => {
            res.redirect('/');
        });
    },

    showAccount: (req, res) => {
        const userId = req.session.user.id;
        User.findById(userId, (err, freshUser) => {
            if (!err && freshUser) {
                req.session.user = { ...req.session.user, ...freshUser };
            }
            res.render('account', {
                user: req.session.user,
                messages: req.flash('success'),
                errors: req.flash('error')
            });
        });
    },

    updateAccount: (req, res) => {
        const { username, address, contact } = req.body;
        if (!username || !address || !contact) {
            req.flash('error', 'All fields are required.');
            return res.redirect('/account');
        }
        const digits = (contact || '').replace(/\D/g, '');
        if (digits.length !== 8) {
            req.flash('error', 'Contact number must be 8 digits.');
            return res.redirect('/account');
        }

        User.updateProfile(req.session.user.id, { username, address, contact: digits }, (err) => {
            if (err) {
                console.error('Account update error:', err);
                req.flash('error', 'Could not update account.');
                return res.redirect('/account');
            }
            req.session.user.username = username;
            req.session.user.address = address;
            req.session.user.contact = digits;
            req.flash('success', 'Account updated.');
            res.redirect('/account');
        });
    },

    deleteAccount: (req, res) => {
        User.softDelete(req.session.user.id, (err) => {
            if (err) {
                console.error('Account delete error:', err);
                req.flash('error', 'Could not delete account.');
                return res.redirect('/account');
            }
            req.session.destroy(() => {
                res.redirect('/login');
            });
        });
    },

    showForgotPassword: (req, res) => {
        res.render('forgotPassword', {
            errors: req.flash('error'),
            messages: req.flash('success'),
            user: req.session.user
        });
    },

    forgotPassword: (req, res) => {
        const { email } = req.body;
        if (!email) {
            req.flash('error', 'Email is required');
            return res.redirect('/forgot-password');
        }
        res.render('resetPassword', {
            email,
            errors: [],
            messages: [],
            user: req.session.user
        });
    },

    resetPassword: (req, res) => {
        const { email, password, confirmPassword } = req.body;
        if (!email || !password || !confirmPassword) {
            req.flash('error', 'All fields are required');
            return res.redirect('/forgot-password');
        }
        if (password !== confirmPassword) {
            req.flash('error', 'Passwords do not match');
            return res.redirect('/forgot-password');
        }
        if (password.length < 6) {
            req.flash('error', 'Password must be at least 6 characters');
            return res.redirect('/forgot-password');
        }

        User.updatePassword(email, password, (err, result) => {
            if (err) {
                console.error('Reset password error:', err);
                req.flash('error', 'Database error');
                return res.redirect('/forgot-password');
            }
            if (result.affectedRows === 0) {
                req.flash('error', 'Email not found');
                return res.redirect('/forgot-password');
            }
            req.flash('success', 'Password updated. Please log in.');
            res.redirect('/login');
        });
    }
};

module.exports = UserController;
